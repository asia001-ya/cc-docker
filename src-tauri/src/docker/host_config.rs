//! 宿主 Claude 配置的只读发现、校验与独立 MCP 导出。
//! 原始 Claude / 插件配置不会直接挂载到容器；仅导出合并后的 mcpServers。

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

pub const HOST_CONFIG_ROOT: &str = "/opt/tdc/host-config";
pub const HOST_MCP_TARGET: &str = "/opt/tdc/host-config/mcp";

/// 路径均指向本机；空值表示继续使用容器自己的配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct HostClaudeConfig {
    pub skills: Option<String>,
    pub commands: Option<String>,
    pub agents: Option<String>,
    pub claude_md: Option<String>,
    /// 按数组顺序合并，同名 MCP 服务采用后一个文件的完整定义。
    pub mcp_configs: Vec<String>,
}

impl HostClaudeConfig {
    pub fn normalized(&self) -> Self {
        fn trim_optional(value: &Option<String>) -> Option<String> {
            value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned)
        }

        Self {
            skills: trim_optional(&self.skills),
            commands: trim_optional(&self.commands),
            agents: trim_optional(&self.agents),
            claude_md: trim_optional(&self.claude_md),
            mcp_configs: self
                .mcp_configs
                .iter()
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        let config = self.normalized();
        config.skills.is_none()
            && config.commands.is_none()
            && config.agents.is_none()
            && config.claude_md.is_none()
            && config.mcp_configs.is_empty()
    }
}

/// 不实现 Serialize，避免误把合并后的 MCP 凭据作为命令返回值发往前端。
pub struct HostConfigPrepared {
    pub config: HostClaudeConfig,
    pub mcp_servers: Map<String, Value>,
    pub warnings: Vec<String>,
}

impl HostConfigPrepared {
    /// 每次应用使用全新的目录，绝不覆盖运行中容器正在挂载的导出文件。
    /// 返回可只读绑定到 HOST_MCP_TARGET 的目录；未选择 MCP 来源时不创建文件。
    pub fn persist_mcp(&self, staging_root: &Path) -> AppResult<Option<PathBuf>> {
        if self.config.mcp_configs.is_empty() {
            return Ok(None);
        }
        if !staging_root.is_absolute() {
            return Err(AppError::Invalid("MCP 导出目录必须是本机绝对路径".into()));
        }

        let payload = serde_json::to_vec(&serde_json::json!({ "mcpServers": &self.mcp_servers }))
            .map_err(|_| AppError::Other("无法生成 MCP 导出文件".into()))?;
        fs::create_dir_all(staging_root).map_err(|_| AppError::Io("无法创建 MCP 导出根目录".into()))?;
        let directory = staging_root.join(uuid::Uuid::new_v4().to_string());
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder.create(&directory).map_err(|_| AppError::Io("无法创建独立 MCP 导出目录".into()))?;

        let target = directory.join("mcp.json");
        let result = (|| -> std::io::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&target)?;
            file.write_all(&payload)?;
            file.sync_all()
        })();
        if result.is_err() {
            // 只清理本次创建的文件与空目录，不递归触碰其它世代的导出。
            let _ = fs::remove_file(&target);
            let _ = fs::remove_dir(&directory);
            return Err(AppError::Io("无法写入 MCP 导出文件".into()));
        }
        Ok(Some(directory))
    }

    /// 仅用于用户显式应用和失败回滚；预检不得调用此方法。
    /// 替换受控目录中的 MCP 导出，挂载目录保持不变，读者只会看到完整的新旧文件。
    pub fn replace_mcp_export(&self, export_dir: &Path, staging_root: &Path) -> AppResult<()> {
        let root =
            fs::canonicalize(staging_root).map_err(|_| AppError::Invalid("MCP 暂存根目录不存在或无法访问".into()))?;
        let directory =
            fs::canonicalize(export_dir).map_err(|_| AppError::Invalid("MCP 导出目录不存在或无法访问".into()))?;
        let uuid_directory = directory
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok_and(|uuid| uuid.to_string() == name));
        if !root.is_dir() || !directory.is_dir() || directory.parent() != Some(root.as_path()) || !uuid_directory {
            return Err(AppError::Invalid("MCP 导出目录必须是受控暂存根目录内的直接 UUID 子目录".into()));
        }
        let target = directory.join("mcp.json");
        let metadata =
            fs::symlink_metadata(&target).map_err(|_| AppError::Invalid("MCP 导出文件不存在或无法访问".into()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AppError::Invalid("MCP 导出文件必须是普通文件，不能是符号链接".into()));
        }

        let payload = serde_json::to_vec(&serde_json::json!({ "mcpServers": &self.mcp_servers }))
            .map_err(|_| AppError::Other("无法生成 MCP 导出文件".into()))?;
        let temporary = directory.join(format!(".mcp-{}.tmp", uuid::Uuid::new_v4()));
        let mut created = false;
        let result = (|| -> std::io::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            created = true;
            file.write_all(&payload)?;
            file.sync_all()?;
            // Windows 在替换前需要释放临时文件句柄。
            drop(file);
            fs::rename(&temporary, &target)
        })();
        if result.is_err() {
            if created {
                let _ = fs::remove_file(&temporary);
            }
            return Err(AppError::Io("无法原子替换 MCP 导出文件，原配置未被覆盖".into()));
        }
        Ok(())
    }
}

/// 尽力发现用户级配置，读取失败或配置不存在均返回可用的其余项。
pub fn defaults() -> HostClaudeConfig {
    #[cfg(windows)]
    let candidates = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let candidates = ["HOME", "USERPROFILE"];

    candidates
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .find(|path| path.is_absolute() && path.is_dir())
        .map(|home| defaults_at(&home))
        .unwrap_or_default()
}

fn defaults_at(home: &Path) -> HostClaudeConfig {
    let claude = home.join(".claude");
    let path_if = |path: PathBuf, directory: bool| {
        if (directory && path.is_dir()) || (!directory && path.is_file()) {
            path.to_str().map(str::to_owned)
        } else {
            None
        }
    };
    let mut config = HostClaudeConfig {
        skills: path_if(claude.join("skills"), true),
        commands: path_if(claude.join("commands"), true),
        agents: path_if(claude.join("agents"), true),
        claude_md: path_if(claude.join("CLAUDE.md"), false),
        mcp_configs: Vec::new(),
    };

    let settings = read_json_best_effort(&claude.join("settings.json"));
    let installed = read_json_best_effort(&claude.join("plugins/installed_plugins.json"));
    let enabled = settings.as_ref().and_then(|v| v.get("enabledPlugins")).and_then(Value::as_object);
    let plugins = installed.as_ref().and_then(|v| v.get("plugins")).and_then(Value::as_object);
    if let (Some(enabled), Some(plugins)) = (enabled, plugins) {
        let mut ids: Vec<_> =
            enabled.iter().filter(|(_, value)| value.as_bool() == Some(true)).map(|(id, _)| id).collect();
        ids.sort();
        for id in ids {
            let Some(registrations) = plugins.get(id) else { continue };
            // v2 的值为安装记录数组；兼容旧版本的单条安装记录对象。
            let entries: Vec<&Value> = match registrations {
                Value::Array(entries) => entries.iter().collect(),
                Value::Object(_) => vec![registrations],
                _ => continue,
            };
            for entry in entries {
                let Some(entry) = entry.as_object() else { continue };
                // 全局默认值不携带某个项目的专属插件。
                if entry.get("scope").is_some_and(|scope| scope.as_str() != Some("user"))
                    || entry.get("projectPath").is_some_and(|path| !path.is_null())
                {
                    continue;
                }
                let Some(install_path) = entry.get("installPath").and_then(Value::as_str) else { continue };
                let install_path = Path::new(install_path);
                if !install_path.is_absolute() {
                    continue;
                }
                let mcp = install_path.join(".mcp.json");
                if has_valid_mcp_servers(&mcp, false) {
                    if let Some(path) = mcp.to_str() {
                        config.mcp_configs.push(path.to_owned())
                    }
                }
            }
        }
    }

    // 用户显式配置最后合并，覆盖插件同名服务；不把整份 .claude.json 直接共享。
    let user_mcp = home.join(".claude.json");
    if has_valid_mcp_servers(&user_mcp, true) {
        if let Some(path) = user_mcp.to_str() {
            config.mcp_configs.push(path.to_owned())
        }
    }
    let mut seen = HashSet::new();
    config.mcp_configs.retain(|path| seen.insert(path.clone()));
    config
}

fn read_json_best_effort(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn has_valid_mcp_servers(path: &Path, require_wrapper: bool) -> bool {
    let Some(value) = read_json_best_effort(path) else { return false };
    if require_wrapper && !value.get("mcpServers").is_some_and(Value::is_object) {
        return false;
    }
    extract_servers(value, 1).is_ok_and(|servers| !servers.is_empty())
}

/// 纯读取：校验路径和 JSON，按输入顺序合并 MCP；不会产生或改写导出文件。
pub fn validate(config: &HostClaudeConfig) -> AppResult<HostConfigPrepared> {
    let config = config.normalized();
    for (label, value, directory) in [
        ("skills", &config.skills, true),
        ("commands", &config.commands, true),
        ("agents", &config.agents, true),
        ("CLAUDE.md", &config.claude_md, false),
    ] {
        if let Some(value) = value {
            validate_path(value, label, directory)?;
        }
    }

    let mut mcp_servers = Map::new();
    let mut overridden = BTreeMap::new();
    for (index, source) in config.mcp_configs.iter().enumerate() {
        let number = index + 1;
        validate_path(source, &format!("MCP 配置文件 #{number}"), false)?;
        let bytes = fs::read(source).map_err(|_| AppError::Io(format!("无法读取 MCP 配置文件 #{number}")))?;
        let value = serde_json::from_slice(&bytes)
            .map_err(|_| AppError::Invalid(format!("MCP 配置文件 #{number} 不是有效的 JSON")))?;
        for (name, server) in extract_servers(value, number)? {
            if mcp_servers.insert(name.clone(), server).is_some() {
                overridden.insert(name, number);
            }
        }
    }
    // 只针对最终生效的配置提示，已被后续文件覆盖的定义不产生过期提示。
    let mut warnings: Vec<_> = overridden
        .into_iter()
        .map(|(name, number)| {
            let name = safe_server_name(&name);
            format!("MCP 服务“{name}”在多个文件中重复定义，已采用配置文件 #{number} 中的定义（后一个文件优先）。")
        })
        .collect();
    warnings.extend(portability_warnings(&mcp_servers));
    Ok(HostConfigPrepared { config, mcp_servers, warnings })
}

fn validate_path(value: &str, label: &str, directory: bool) -> AppResult<()> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(AppError::Invalid(format!("{label} 必须使用本机绝对路径")));
    }
    let metadata = fs::metadata(path).map_err(|_| AppError::Invalid(format!("{label} 不存在或无法访问")))?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        let kind = if directory { "目录" } else { "文件" };
        return Err(AppError::Invalid(format!("{label} 必须是{kind}")));
    }
    Ok(())
}

fn extract_servers(value: Value, number: usize) -> AppResult<Map<String, Value>> {
    let invalid = |message: &str| AppError::Invalid(format!("MCP 配置文件 #{number}：{message}"));
    let Value::Object(mut document) = value else {
        return Err(invalid("顶层必须是 JSON 对象"));
    };
    let servers = if let Some(servers) = document.remove("mcpServers") {
        let Value::Object(servers) = servers else { return Err(invalid("mcpServers 必须是对象")) };
        servers
    } else {
        document
    };
    for (name, server) in &servers {
        if name.trim().is_empty() {
            return Err(invalid("MCP 服务名不能为空"));
        }
        let safe_name = safe_server_name(name);
        let error = |reason: &str| invalid(&format!("服务“{safe_name}”{reason}"));
        let Some(server) = server.as_object() else { return Err(error("必须是对象")) };
        for key in ["command", "url", "type", "cwd"] {
            if server.get(key).is_some_and(|v| !v.as_str().is_some_and(|s| !s.trim().is_empty())) {
                return Err(error(&format!("的 {key} 必须是非空字符串")));
            }
        }
        let command = server.contains_key("command");
        let url = server.contains_key("url");
        if command == url {
            return Err(error("必须提供 command 或 url 中的一项"));
        }
        if let Some(kind) = server.get("type").and_then(Value::as_str) {
            match kind {
                "stdio" if command => {}
                "http" | "sse" if url => {}
                "stdio" | "http" | "sse" => return Err(error("的传输类型与 command / url 不匹配")),
                _ => return Err(error("的传输类型不受支持")),
            }
        }
        if let Some(args) = server.get("args") {
            if !args.as_array().is_some_and(|args| args.iter().all(Value::is_string)) {
                return Err(error("的 args 必须是字符串数组"));
            }
        }
        for key in ["env", "headers"] {
            if let Some(value) = server.get(key) {
                if !value.as_object().is_some_and(|values| values.values().all(Value::is_string)) {
                    return Err(error(&format!("的 {key} 必须是字符串值对象")));
                }
            }
        }
    }
    Ok(servers)
}

fn safe_server_name(name: &str) -> String {
    name.chars().take(120).map(|c| if c.is_control() { ' ' } else { c }).collect()
}

fn portability_warnings(servers: &Map<String, Value>) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut entries: Vec<_> = servers.iter().collect();
    entries.sort_by_key(|(name, _)| *name);
    for (name, server) in entries {
        let name = safe_server_name(name);
        let mut values = Vec::new();
        collect_strings(server, &mut values);
        if let Some(command) = server.get("command").and_then(Value::as_str) {
            warnings.push(format!(
                "MCP 服务“{name}”使用 stdio：共享配置不会安装程序或依赖，请确认命令和运行时已在容器内可用。"
            ));
            if is_windows_command(command) {
                warnings.push(format!(
                    "MCP 服务“{name}”使用 Windows 命令，无法直接在 Linux 容器内执行，请改用容器内可用的命令。"
                ));
            }
        }
        if values.iter().any(|value| is_absolute_config_path(value)) {
            warnings.push(format!("MCP 服务“{name}”包含绝对路径，请确认对应文件已挂载且路径适用于 Linux 容器。"));
        }
        if values.iter().any(|value| value.contains("${CLAUDE_PLUGIN_ROOT}")) {
            warnings.push(format!(
                "MCP 服务“{name}”依赖 ${{CLAUDE_PLUGIN_ROOT}}；独立导出不会复制插件程序，请将其改为容器内可用路径。"
            ));
        }
        if values.iter().any(|value| is_loopback_endpoint(value)) {
            warnings.push(format!("MCP 服务“{name}”连接 localhost / 回环地址，在容器内会指向容器自身；访问宿主服务时需使用容器可达的宿主地址。"));
        }
    }
    warnings
}

fn collect_strings<'a>(value: &'a Value, output: &mut Vec<&'a str>) {
    match value {
        Value::String(value) => output.push(value),
        Value::Array(values) => values.iter().for_each(|value| collect_strings(value, output)),
        Value::Object(values) => values.values().for_each(|value| collect_strings(value, output)),
        _ => {}
    }
}

fn is_windows_command(value: &str) -> bool {
    let value = value.trim().trim_matches(['\'', '"']).to_ascii_lowercase();
    let command = value.rsplit(['/', '\\']).next().unwrap_or(&value);
    matches!(command, "cmd" | "cmd.exe" | "powershell" | "powershell.exe" | "wscript" | "cscript")
        || [".exe", ".cmd", ".bat", ".ps1"].iter().any(|suffix| command.ends_with(suffix))
}

fn is_absolute_config_path(value: &str) -> bool {
    let value = value.trim().trim_matches(['\'', '"']);
    // 兼容 --config=/path 和 --config=C:\path，HTTP URL 不属于文件路径。
    let value = if value.starts_with('-') { value.split_once('=').map_or(value, |(_, path)| path) } else { value };
    let bytes = value.as_bytes();
    value.starts_with('/')
        || value.starts_with("\\\\")
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
}

fn is_loopback_endpoint(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.');
            host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost")
        }
        Some(url::Host::Ipv4(address)) => address.is_loopback() || address.is_unspecified(),
        Some(url::Host::Ipv6(address)) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.to_ipv4_mapped().is_some_and(|address| address.is_loopback())
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tdc-host-config-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, path: &str, value: Value) -> String {
            self.write_text(path, &serde_json::to_string(&value).unwrap())
        }
        fn write_text(&self, path: &str, text: &str) -> String {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path.to_str().unwrap().to_owned()
        }
        fn directory(&self, path: &str) -> String {
            let path = self.0.join(path);
            fs::create_dir_all(&path).unwrap();
            path.to_str().unwrap().to_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn with_mcp(paths: Vec<String>) -> HostClaudeConfig {
        HostClaudeConfig { mcp_configs: paths, ..Default::default() }
    }

    #[test]
    fn serde_defaults_and_normalization_preserve_source_order() {
        let empty: HostClaudeConfig = serde_json::from_value(json!({})).unwrap();
        assert!(empty.is_empty());
        let config: HostClaudeConfig = serde_json::from_value(json!({
            "skills":"  ", "claudeMd":" /test/CLAUDE.md ",
            "mcpConfigs":[" first ", " ", "second", " first "]
        }))
        .unwrap();
        let normalized = config.normalized();
        assert_eq!(normalized.skills, None);
        assert_eq!(normalized.claude_md.as_deref(), Some("/test/CLAUDE.md"));
        assert_eq!(normalized.mcp_configs, ["first", "second", "first"]);
        assert!(!config.is_empty());
        assert!(serde_json::from_value::<HostClaudeConfig>(json!({"mcpConfigs":[{}]})).is_err());
    }

    #[test]
    fn validates_paths_and_kinds_without_echoing_paths() {
        let fixture = Fixture::new();
        let file = fixture.write_text("notes.md", "private-content");
        let directory = fixture.directory("skills");
        let valid =
            HostClaudeConfig { skills: Some(directory.clone()), claude_md: Some(file.clone()), ..Default::default() };
        assert!(validate(&valid).is_ok());
        for config in [
            HostClaudeConfig { skills: Some("relative-secret-path".into()), ..Default::default() },
            HostClaudeConfig { skills: Some(file), ..Default::default() },
            HostClaudeConfig { claude_md: Some(directory), ..Default::default() },
            with_mcp(vec![fixture.0.join("missing-secret.json").to_str().unwrap().into()]),
        ] {
            let message = validate(&config).err().expect("invalid path").to_string();
            assert!(!message.contains("secret"));
            assert!(!message.contains(&fixture.0.to_string_lossy().to_string()));
        }
    }

    #[test]
    fn merges_wrapped_and_direct_maps_with_last_file_winning() {
        let fixture = Fixture::new();
        let first = fixture.write(
            "one.json",
            json!({"mcpServers":{
            "shared":{"command":"cmd.exe","env":{"TOKEN":"old-secret"}},
            "kept":{"command":"node","args":["server.js"]}
        }, "oauthAccount":{"token":"account-secret"}, "projects":{"/private":{}}}),
        );
        let second = fixture.write(
            "two.json",
            json!({
                "shared":{"type":"http","url":"https://example.test/mcp"},
                "new":{"command":"npx","args":["example-mcp"]}
            }),
        );
        let prepared = validate(&with_mcp(vec![first.clone(), second.clone()])).unwrap();
        assert_eq!(prepared.mcp_servers.len(), 3);
        assert_eq!(prepared.mcp_servers["shared"], json!({"type":"http","url":"https://example.test/mcp"}));
        assert!(prepared.warnings.iter().any(|warning| warning.contains("shared") && warning.contains("#2")));
        assert!(prepared.warnings.iter().all(|warning| !warning.contains("Windows")));
        let repeated = validate(&with_mcp(vec![first.clone(), second, first])).unwrap();
        assert_eq!(repeated.mcp_servers["shared"]["command"], "cmd.exe");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2, "validation must not write staging files");
    }

    #[test]
    fn rejects_malformed_sources_without_exposing_content() {
        let fixture = Fixture::new();
        let malformed = fixture.write_text("broken.json", "{\"mcpServers\":super-private-token}");
        assert!(!validate(&with_mcp(vec![malformed])).err().unwrap().to_string().contains("super-private-token"));
        for value in [
            json!([]),
            json!({"mcpServers": []}),
            json!({"mcpServers":{"bad":"super-private-token"}}),
            json!({"mcpServers":{"bad":{"command":123}}}),
            json!({"mcpServers":{"bad":{"command":"node","args":["ok",123]}}}),
            json!({"mcpServers":{"bad":{"command":"node","env":{"TOKEN":123}}}}),
            json!({"mcpServers":{"bad":{"url":"https://example.test","headers":[]}}}),
            json!({"mcpServers":{"bad":{"command":"node","url":"https://example.test"}}}),
            json!({"mcpServers":{"bad":{"command":"node","type":"http"}}}),
            json!({"mcpServers":{"bad":{"private":"super-private-token"}}}),
            json!({"mcpServers":{" ":{"command":"node"}}}),
        ] {
            let path = fixture.write("invalid.json", value);
            let message = validate(&with_mcp(vec![path])).err().expect("malformed input").to_string();
            assert!(!message.contains("super-private-token"));
            assert!(!message.contains(&fixture.0.to_string_lossy().to_string()));
        }
    }

    #[test]
    fn warnings_name_affected_servers_without_echoing_commands_or_credentials() {
        let fixture = Fixture::new();
        let path = fixture.write("warnings.json", json!({
            "windows":{"command":"C:\\private-secret\\cmd.exe","args":["${CLAUDE_PLUGIN_ROOT}/server.js"],"env":{"TOKEN":"super-private-token"}},
            "local":{"url":"http://user:super-private-token@localhost:9123/mcp?key=hidden"},
            "ipv6":{"url":"http://[::1]:9123/mcp"},
            "absolute":{"command":"node","args":["--config=/private-secret/config.json"]},
            "remote":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer super-private-token"}}
        }));
        let warnings = validate(&with_mcp(vec![path])).unwrap().warnings;
        assert!(warnings.iter().any(|w| w.contains("windows") && w.contains("Windows")));
        assert!(warnings.iter().any(|w| w.contains("windows") && w.contains("CLAUDE_PLUGIN_ROOT")));
        assert!(warnings.iter().any(|w| w.contains("windows") && w.contains("stdio")));
        assert!(warnings.iter().any(|w| w.contains("absolute") && w.contains("绝对路径")));
        assert!(warnings.iter().any(|w| w.contains("local") && w.contains("localhost")));
        assert!(warnings.iter().any(|w| w.contains("ipv6") && w.contains("localhost")));
        assert!(warnings.iter().all(|w| !w.contains("private-secret")
            && !w.contains("super-private-token")
            && !w.contains("hidden")
            && !w.contains("remote")));
    }

    #[test]
    fn defaults_only_include_enabled_registered_user_plugins_and_nonempty_user_mcp() {
        let fixture = Fixture::new();
        let skills = fixture.directory(".claude/skills");
        fixture.directory(".claude/agents");
        fixture.write_text(".claude/commands", "wrong-kind");
        fixture.write_text(".claude/CLAUDE.md", "instructions");
        let plugin_a = fixture.directory("plugins/a");
        let plugin_z = fixture.directory("plugins/z");
        let plugin_off = fixture.directory("plugins/off");
        let plugin_project = fixture.directory("plugins/project");
        for plugin in ["a", "z", "off", "project", "unregistered"] {
            fixture.write(&format!("plugins/{plugin}/.mcp.json"), json!({"same":{"command":"node","args":[plugin]}}));
        }
        fixture.write(
            ".claude/settings.json",
            json!({"enabledPlugins":{
                "z@market":true,"a@market":true,"off@market":false,"project@market":true,"unregistered@market":true
            }}),
        );
        fixture.write(
            ".claude/plugins/installed_plugins.json",
            json!({"version":2,"plugins":{
                "z@market":[{"scope":"user","installPath":plugin_z}],
                "a@market":[{"scope":"user","installPath":plugin_a}],
                "off@market":[{"scope":"user","installPath":plugin_off}],
                "project@market":[{"scope":"project","installPath":plugin_project}]
            }}),
        );
        let user = fixture.write(
            ".claude.json",
            json!({"oauthAccount":{"token":"account-secret"},"mcpServers":{"same":{"command":"node","args":["user"]}}}),
        );
        let config = defaults_at(&fixture.0);
        assert_eq!(config.skills.as_deref().map(Path::new), Some(Path::new(&skills)));
        assert_eq!(config.commands, None);
        assert!(config.agents.is_some() && config.claude_md.is_some());
        assert_eq!(
            config.mcp_configs.iter().map(PathBuf::from).collect::<Vec<_>>(),
            [fixture.0.join("plugins/a/.mcp.json"), fixture.0.join("plugins/z/.mcp.json"), PathBuf::from(user)]
        );
        let prepared = validate(&config).unwrap();
        assert_eq!(prepared.mcp_servers["same"]["args"], json!(["user"]));
    }

    #[test]
    fn defaults_are_best_effort_and_do_not_guess_user_json_server_maps() {
        let fixture = Fixture::new();
        assert!(defaults_at(&fixture.0).is_empty());
        fixture.write_text(".claude/settings.json", "broken");
        fixture.write(".claude.json", json!({"mcpServers":{},"oauthAccount":{"token":"secret"}}));
        assert!(defaults_at(&fixture.0).mcp_configs.is_empty());
        fixture.write(".claude.json", json!({"oauthAccount":{"command":"unrelated"}}));
        assert!(defaults_at(&fixture.0).mcp_configs.is_empty());
        fixture.write_text(".claude.json", "broken");
        assert!(defaults_at(&fixture.0).is_empty());
    }

    #[test]
    fn export_is_isolated_and_contains_only_merged_mcp_servers() {
        let fixture = Fixture::new();
        let source = fixture.write(
            "source.json",
            json!({
                "oauthAccount":{"token":"account-secret"},"projects":{"private":{}},
                "mcpServers":{"test":{"command":"node","env":{"TOKEN":"mcp-secret"}}}
            }),
        );
        let prepared = validate(&with_mcp(vec![source.clone()])).unwrap();
        let staging = fixture.0.join("staging");
        assert!(!staging.exists());
        let first = prepared.persist_mcp(&staging).unwrap().unwrap();
        let original = fs::read(first.join("mcp.json")).unwrap();
        let second = prepared.persist_mcp(&staging).unwrap().unwrap();
        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(staging.as_path()));
        assert_eq!(fs::read(first.join("mcp.json")).unwrap(), original);
        assert_eq!(fs::read_dir(&first).unwrap().count(), 1);
        let exported: Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(exported, json!({"mcpServers":{"test":{"command":"node","env":{"TOKEN":"mcp-secret"}}}}));
        assert!(!String::from_utf8(original).unwrap().contains("account-secret"));
        assert!(fs::read_to_string(source).unwrap().contains("account-secret"), "source must remain unchanged");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&first).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(first.join("mcp.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn empty_mcp_does_not_create_export_root() {
        let fixture = Fixture::new();
        let prepared = validate(&HostClaudeConfig::default()).unwrap();
        let staging = fixture.0.join("must-not-exist");
        assert_eq!(prepared.persist_mcp(&staging).unwrap(), None);
        assert!(!staging.exists());
    }

    #[test]
    fn explicitly_selected_empty_mcp_still_exports_a_directory() {
        let fixture = Fixture::new();
        let source = fixture.write("empty.json", json!({"mcpServers":{},"oauthAccount":{"token":"account-secret"}}));
        let prepared = validate(&with_mcp(vec![source])).unwrap();
        assert!(prepared.mcp_servers.is_empty());
        let directory =
            prepared.persist_mcp(&fixture.0.join("staging")).unwrap().expect("an enabled MCP source needs a mount");
        let exported: Value = serde_json::from_slice(&fs::read(directory.join("mcp.json")).unwrap()).unwrap();
        assert_eq!(exported, json!({"mcpServers":{}}));
    }

    #[test]
    fn controlled_export_can_be_replaced_and_rolled_back_without_source_fields() {
        let fixture = Fixture::new();
        let old_source = fixture.write("old.json", json!({"mcpServers":{"old":{"command":"node"}}}));
        let old = validate(&with_mcp(vec![old_source])).unwrap();
        let staging = fixture.0.join("staging");
        let directory = old.persist_mcp(&staging).unwrap().unwrap();
        let original = fs::read(directory.join("mcp.json")).unwrap();
        let source = fixture.write(
            "new.json",
            json!({
                "oauthAccount":{"token":"account-secret"},"projects":{"private":{}},
                "mcpServers":{"new":{"command":"node","env":{"TOKEN":"mcp-secret"}}}
            }),
        );
        let new = validate(&with_mcp(vec![source.clone()])).unwrap();
        new.replace_mcp_export(&directory, &staging).unwrap();
        let exported: Value = serde_json::from_slice(&fs::read(directory.join("mcp.json")).unwrap()).unwrap();
        assert_eq!(exported, json!({"mcpServers":{"new":{"command":"node","env":{"TOKEN":"mcp-secret"}}}}));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1, "temporary files must be removed");
        assert!(fs::read_to_string(source).unwrap().contains("account-secret"));
        old.replace_mcp_export(&directory, &staging).unwrap();
        assert_eq!(fs::read(directory.join("mcp.json")).unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(directory.join("mcp.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn export_replacement_rejects_external_nested_and_non_uuid_directories() {
        let fixture = Fixture::new();
        let source = fixture.write("source.json", json!({"mcpServers":{"test":{"command":"node"}}}));
        let prepared = validate(&with_mcp(vec![source])).unwrap();
        let staging = fixture.0.join("staging");
        fs::create_dir(&staging).unwrap();
        for directory in [
            fixture.0.join("staging-outside").join(uuid::Uuid::new_v4().to_string()),
            staging.join("nested").join(uuid::Uuid::new_v4().to_string()),
            staging.join("not-a-uuid"),
        ] {
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("mcp.json"), "original-private-value").unwrap();
            let error = prepared.replace_mcp_export(&directory, &staging).unwrap_err().to_string();
            assert!(error.contains("直接 UUID 子目录"));
            assert!(!error.contains("original-private-value"));
            assert_eq!(fs::read_to_string(directory.join("mcp.json")).unwrap(), "original-private-value");
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        }
        let directory = staging.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(directory.join("mcp.json")).unwrap();
        assert!(prepared.replace_mcp_export(&directory, &staging).unwrap_err().to_string().contains("普通文件"));
    }

    #[cfg(unix)]
    #[test]
    fn export_replacement_rejects_symlinked_file_and_directory_escape() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let prepared = validate(&HostClaudeConfig::default()).unwrap();
        let staging = fixture.0.join("staging");
        let directory = staging.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).unwrap();
        let outside = fixture.write_text("outside.json", "original-private-value");
        symlink(&outside, directory.join("mcp.json")).unwrap();
        assert!(prepared.replace_mcp_export(&directory, &staging).unwrap_err().to_string().contains("符号链接"));
        assert_eq!(fs::read_to_string(outside).unwrap(), "original-private-value");
        let outside_dir = fixture.directory("outside");
        let link = staging.join(uuid::Uuid::new_v4().to_string());
        symlink(outside_dir, &link).unwrap();
        assert!(prepared.replace_mcp_export(&link, &staging).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn failed_export_replacement_keeps_original_and_cleans_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let source = fixture.write("source.json", json!({"mcpServers":{"test":{"command":"node"}}}));
        let old = validate(&with_mcp(vec![source])).unwrap();
        let staging = fixture.0.join("staging");
        let directory = old.persist_mcp(&staging).unwrap().unwrap();
        let target = directory.join("mcp.json");
        let original = fs::read(&target).unwrap();
        let locked = OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        let empty = validate(&HostClaudeConfig::default()).unwrap();
        assert!(empty.replace_mcp_export(&directory, &staging).unwrap_err().to_string().contains("无法原子替换"));
        drop(locked);
        assert_eq!(fs::read(target).unwrap(), original);
        assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
    }

    #[test]
    fn warnings_cover_windows_unc_paths_and_loopback_variants() {
        for path in [
            "C:\\server\\main.js",
            "D:/server/main.js",
            "\\\\host\\share\\server.js",
            "/opt/server/main.js",
            "--config=C:\\server\\config.json",
        ] {
            assert!(is_absolute_config_path(path));
        }
        for path in ["server.js", "https://example.test/mcp", "@vendor/server", "${CLAUDE_PLUGIN_ROOT}/server.js"] {
            assert!(!is_absolute_config_path(path));
        }
        for endpoint in [
            "http://localhost:1",
            "http://LOCALHOST.:1",
            "http://mcp.localhost:1",
            "http://127.0.0.2:1",
            "http://[::1]:1",
            "http://[::ffff:127.0.0.1]:1",
            "http://0.0.0.0:1",
        ] {
            assert!(is_loopback_endpoint(endpoint));
        }
        for endpoint in [
            "https://example.test/mcp?next=localhost",
            "http://localhost.example.test",
            "http://host.docker.internal:1",
        ] {
            assert!(!is_loopback_endpoint(endpoint));
        }
    }
}
