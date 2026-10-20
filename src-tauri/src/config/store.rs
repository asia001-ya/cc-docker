//! 全局设置与会话布局的持久化（%APPDATA%\com.tdc.app\*.json）。
//!
//! - settings.json：外观、Docker 连接、额度阈值、快捷键偏好
//! - sessions.json：终端会话元数据（显示名、容器、tmux 会话 ID、cwd），用于应用重启后重新附着
//!
//! API Token 不在此保存，统一走 Windows 凭据管理器（providers::store）。

use std::fs;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::wallpaper::{self, WallpaperAsset, WallpaperKind, WallpaperSettings};

/// 终端外观设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalSettings {
    /// 字体族（JetBrains Mono / Fira Code / Cascadia Code）
    pub font_family: String,
    /// 字号（px）
    pub font_size: u16,
    /// 行高倍数
    pub line_height: f32,
    /// 配色方案 ID（fluent / one-dark / catppuccin-mocha / dracula）
    pub theme: String,
    /// 光标样式（block / bar / underline）
    pub cursor_style: String,
    /// 光标闪烁
    pub cursor_blink: bool,
    /// 启用 WebGL 渲染器
    pub webgl: bool,
    /// 启用连字
    pub ligatures: bool,
    /// 回滚行数（tmux 之外的 xterm 本地缓冲）
    pub scrollback: u32,
}

impl Default for TerminalSettings {
    /// 默认外观：DESIGN.md 指定的 JetBrains Mono + Fluent 高对比配色。
    /// 参数：无；返回：默认设置。
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono".into(),
            font_size: 14,
            line_height: 1.2,
            theme: "fluent".into(),
            cursor_style: "block".into(),
            cursor_blink: true,
            webgl: true,
            ligatures: true,
            scrollback: 5000,
        }
    }
}

/// 额度相关设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuotaSettings {
    /// 轮询间隔（秒）
    pub refresh_secs: u32,
    /// 黄色预警阈值（剩余百分比 ≤ 该值且 ≥ critical 为黄）
    pub warn_threshold: f64,
    /// 红色阈值（剩余百分比 < 该值为红）
    pub critical_threshold: f64,
    /// 触发热切换的已用百分比阈值
    pub switch_threshold: f64,
    /// 达到阈值时自动弹出切换弹框
    pub auto_prompt: bool,
    /// 允许 API 模式容器作为最后的切换候选（会产生按量费用）
    pub allow_api_fallback: bool,
    /// 候选包含已停止的订阅容器（切换前自动启动）
    pub include_stopped: bool,
    /// 终端输出中识别限额提示的正则（辅助信号）
    pub limit_patterns: Vec<String>,
}

impl Default for QuotaSettings {
    /// 默认阈值与 DESIGN.md 状态色一致。
    /// 参数：无；返回：默认设置。
    fn default() -> Self {
        Self {
            refresh_secs: 5,
            warn_threshold: 30.0,
            critical_threshold: 5.0,
            switch_threshold: 100.0,
            auto_prompt: true,
            allow_api_fallback: false,
            include_stopped: false,
            limit_patterns: vec![
                r"(?i)\busage limit (reached|exceeded)\b".into(),
                r"(?i)\byou['’]ve (hit|reached) your [^\r\n]*\blimit\b".into(),
                r"(?i)\b(5[- ]hour|weekly) (usage )?limit (reached|exceeded|hit)\b".into(),
            ],
        }
    }
}

impl QuotaSettings {
    /// 更新旧版默认识别规则；用户自定义规则保持原样。
    fn normalize_loaded(&mut self) {
        let legacy = [
            r"(?i)usage limit reached",
            r"(?i)you've (hit|reached) your .*limit",
            r"(?i)(5-hour|weekly) limit",
            r"(?i)limit will reset",
        ];
        if self.limit_patterns.iter().map(String::as_str).eq(legacy) {
            self.limit_patterns = Self::default().limit_patterns;
        }
    }
}

/// Docker 连接设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DockerSettings {
    /// 引擎地址；空串表示使用平台默认（Windows：npipe:////./pipe/docker_engine）
    pub host: String,
    /// 默认镜像
    pub default_image: String,
}

impl Default for DockerSettings {
    /// 默认连接本机 Docker Desktop。
    /// 参数：无；返回：默认设置。
    fn default() -> Self {
        Self { host: String::new(), default_image: "tdc/claude-dev:latest".into() }
    }
}

/// 全局设置根对象。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 终端外观
    pub terminal: TerminalSettings,
    /// 壁纸、透明度与玻璃效果；未选择资源时保持原来的外观。
    pub wallpaper: WallpaperSettings,
    /// 额度
    pub quota: QuotaSettings,
    /// Docker 连接
    pub docker: DockerSettings,
    /// 授权账号用量的参考定价（不代表订阅账单）。
    pub default_pricing: crate::providers::DefaultPricing,
    /// 侧栏快捷键（ctrl+shift+b / ctrl+b）
    pub sidebar_shortcut: String,
}

/// 持久化的终端会话元数据。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    /// tdc 会话 ID（tmux 会话名 = tdc-<id>）
    pub id: String,
    /// 所属容器名
    pub container: String,
    /// 显示名（可中文）
    pub title: String,
    /// 启动时的工作目录
    pub cwd: String,
    /// 启动模式：claude / bash / cmd
    pub mode: String,
    /// 模式参数（claude 额外参数或自定义命令）
    #[serde(default)]
    pub args: Vec<String>,
    /// 附加环境变量 K=V
    #[serde(default)]
    pub env: Vec<String>,
    /// 是否使用 tmux 持久化
    #[serde(default = "default_true")]
    pub tmux: bool,
    /// 创建时间（epoch 秒）
    #[serde(default)]
    pub created_at: i64,
}

/// serde 默认值辅助：true。
/// 参数：无；返回：true。
fn default_true() -> bool {
    true
}

/// 配置存储：内存缓存 + 原子落盘。
pub struct ConfigStore {
    dir: PathBuf,
    wallpaper_dir: PathBuf,
    settings: Mutex<Settings>,
    sessions: Mutex<Vec<SessionRecord>>,
}

impl ConfigStore {
    /// 从配置目录加载（文件缺失或损坏时使用默认值）。
    /// 参数：dir——应用配置目录；返回：ConfigStore。
    pub fn load(dir: PathBuf) -> Self {
        let wallpaper_dir = dir.join("wallpapers");
        Self::load_with_wallpaper_dir(dir, wallpaper_dir)
    }

    /// 应用入口将媒体放到 app_data_dir，配置仍使用 app_config_dir。
    pub fn load_with_wallpaper_dir(dir: PathBuf, wallpaper_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let mut settings = read_settings(&dir.join("settings.json"));
        settings.quota.normalize_loaded();
        settings.wallpaper.normalize_loaded();
        settings.default_pricing.normalize();
        if settings.default_pricing.validate().is_err() {
            settings.default_pricing = Default::default();
        }
        if settings.sidebar_shortcut.is_empty() {
            settings.sidebar_shortcut = "ctrl+shift+b".into();
        }
        let sessions = read_json(&dir.join("sessions.json")).unwrap_or_default();
        Self { dir, wallpaper_dir, settings: Mutex::new(settings), sessions: Mutex::new(sessions) }
    }

    /// 读取当前设置副本。参数：无；返回：Settings。
    pub fn settings(&self) -> Settings {
        self.settings.lock().clone()
    }

    /// 覆盖设置并落盘。参数：s——新设置；返回：成功与否。
    pub fn set_settings(&self, mut s: Settings) -> AppResult<()> {
        // 与草稿删除共用锁，防止校验后、落盘前资源被清理。
        let mut guard = self.settings.lock();
        s.wallpaper.validate(&self.wallpaper_dir)?;
        s.default_pricing.normalize();
        s.default_pricing.validate()?;
        write_json_atomic(&self.dir.join("settings.json"), &s)?;
        *guard = s;
        Ok(())
    }

    /// 导入媒体不修改已保存配置；前端保存或取消草稿时分别确认/清理。
    pub fn import_wallpaper(&self, source: &Path, kind: WallpaperKind) -> AppResult<WallpaperAsset> {
        wallpaper::import(&self.wallpaper_dir, source, kind)
    }

    pub fn resolve_wallpaper(&self, file_name: &str) -> AppResult<PathBuf> {
        wallpaper::resolve(&self.wallpaper_dir, file_name)
    }

    /// 禁止删除当前已保存配置引用的文件，避免关闭预览时误清理正在使用的壁纸。
    pub fn delete_wallpaper(&self, file_name: &str) -> AppResult<()> {
        let guard = self.settings.lock();
        if guard.wallpaper.asset.as_ref().is_some_and(|asset| asset.file_name == file_name) {
            return Err(AppError::Invalid("不能删除当前已保存设置正在使用的壁纸".into()));
        }
        wallpaper::delete(&self.wallpaper_dir, file_name)
    }

    /// 读取会话记录副本。参数：无；返回：会话列表。
    pub fn sessions(&self) -> Vec<SessionRecord> {
        self.sessions.lock().clone()
    }

    /// 新增或更新会话记录（按 id）。参数：rec——会话记录；返回：成功与否。
    pub fn upsert_session(&self, rec: SessionRecord) -> AppResult<()> {
        let mut guard = self.sessions.lock();
        match guard.iter_mut().find(|r| r.id == rec.id) {
            Some(slot) => *slot = rec,
            None => guard.push(rec),
        }
        write_json_atomic(&self.dir.join("sessions.json"), &*guard)
    }

    /// 删除会话记录。参数：id——会话 ID；返回：成功与否。
    pub fn remove_session(&self, id: &str) -> AppResult<()> {
        let mut guard = self.sessions.lock();
        guard.retain(|r| r.id != id);
        write_json_atomic(&self.dir.join("sessions.json"), &*guard)
    }

    /// 删除某容器的全部会话记录（容器删除时调用）。参数：container——容器名；返回：成功与否。
    pub fn remove_sessions_of(&self, container: &str) -> AppResult<()> {
        let mut guard = self.sessions.lock();
        guard.retain(|r| r.container != container);
        write_json_atomic(&self.dir.join("sessions.json"), &*guard)
    }

    /// 配置目录。参数：无；返回：目录路径。
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// 读取 JSON 文件。
/// 参数：path——文件路径；返回：解析结果，失败返回 None。
fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_settings(path: &Path) -> Settings {
    let Some(mut value) = read_json::<serde_json::Value>(path) else {
        return Settings::default();
    };
    if let Ok(settings) = serde_json::from_value(value.clone()) {
        return settings;
    }
    // 独立恢复新增字段，避免其损坏或未来格式导致其它已有设置丢失。
    if let Some(object) = value.as_object_mut() {
        if object
            .get("wallpaper")
            .is_some_and(|field| serde_json::from_value::<WallpaperSettings>(field.clone()).is_err())
        {
            object.remove("wallpaper");
        }
        if object
            .get("defaultPricing")
            .is_some_and(|field| serde_json::from_value::<crate::providers::DefaultPricing>(field.clone()).is_err())
        {
            object.remove("defaultPricing");
        }
    }
    serde_json::from_value(value).unwrap_or_default()
}

/// 原子写 JSON：写临时文件后 rename。
/// 参数：path——目标文件；value——可序列化对象；返回：成功与否。
pub fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成独立临时目录。参数：tag——目录标签；返回：路径。
    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tdc-cfg-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 缺失文件时使用默认值并补全侧栏快捷键() {
        let store = ConfigStore::load(tmp_dir("default"));
        let s = store.settings();
        assert_eq!(s.terminal.font_family, "JetBrains Mono");
        assert_eq!(s.sidebar_shortcut, "ctrl+shift+b");
        assert_eq!(s.quota.switch_threshold, 100.0);
    }

    #[test]
    fn 加载旧版默认限额规则时迁移并保留其它设置() {
        let dir = tmp_dir("legacy-limit-patterns");
        let mut settings = Settings::default();
        settings.terminal.font_size = 22;
        settings.quota.warn_threshold = 40.0;
        settings.quota.limit_patterns = vec![
            r"(?i)usage limit reached".into(),
            r"(?i)you've (hit|reached) your .*limit".into(),
            r"(?i)(5-hour|weekly) limit".into(),
            r"(?i)limit will reset".into(),
        ];
        write_json_atomic(&dir.join("settings.json"), &settings).unwrap();
        let loaded = ConfigStore::load(dir).settings();
        assert_eq!(loaded.quota.limit_patterns, QuotaSettings::default().limit_patterns);
        assert_eq!(loaded.quota.warn_threshold, 40.0);
        assert_eq!(loaded.terminal.font_size, 22);
    }

    #[test]
    fn 加载时保留自定义或禁用的限额规则() {
        for patterns in [vec![r"(?i)custom limit exceeded".into()], Vec::new()] {
            let dir = tmp_dir("custom-limit-patterns");
            let mut settings = Settings::default();
            settings.quota.limit_patterns = patterns.clone();
            write_json_atomic(&dir.join("settings.json"), &settings).unwrap();
            assert_eq!(ConfigStore::load(dir).settings().quota.limit_patterns, patterns);
        }
    }

    #[test]
    fn 会话记录可增删改并持久化() {
        let dir = tmp_dir("sessions");
        let store = ConfigStore::load(dir.clone());
        let rec = SessionRecord {
            id: "a1".into(),
            container: "claude-dev-01".into(),
            title: "前端开发 #1".into(),
            cwd: "/workspace/app".into(),
            mode: "claude".into(),
            args: vec![],
            env: vec![],
            tmux: true,
            created_at: 1,
        };
        store.upsert_session(rec.clone()).unwrap();
        store.upsert_session(SessionRecord { title: "改名".into(), ..rec.clone() }).unwrap();
        let reloaded = ConfigStore::load(dir);
        assert_eq!(reloaded.sessions().len(), 1);
        assert_eq!(reloaded.sessions()[0].title, "改名");
        reloaded.remove_sessions_of("claude-dev-01").unwrap();
        assert!(reloaded.sessions().is_empty());
    }

    #[test]
    fn 部分字段缺失的设置文件可反序列化() {
        let s: Settings = serde_json::from_str(r#"{"terminal":{"fontSize":18}}"#).unwrap();
        assert_eq!(s.terminal.font_size, 18);
        assert_eq!(s.terminal.theme, "fluent");
        assert_eq!(s.quota.refresh_secs, 5);
        assert_eq!(s.wallpaper, WallpaperSettings::default());
    }

    #[test]
    fn 默认定价补齐官方模型且自定义价格可持久化并拒绝负值() {
        let dir = tmp_dir("default-pricing");
        let store = ConfigStore::load(dir.clone());
        let mut settings = store.settings();
        assert!(settings.default_pricing.model_pricing["claude-sonnet-4-6"].input > 0.0);
        settings.default_pricing.pricing.input = 7.0;
        settings.default_pricing.model_pricing.insert("claude-sonnet-4-6".into(), Default::default());
        store.set_settings(settings.clone()).unwrap();
        let reloaded = ConfigStore::load(dir.clone());
        assert_eq!(reloaded.settings().default_pricing, settings.default_pricing);
        let mut invalid = settings.clone();
        invalid.default_pricing.pricing.output = -1.0;
        assert!(store.set_settings(invalid).is_err());
        assert_eq!(ConfigStore::load(dir).settings().default_pricing, settings.default_pricing);
    }

    #[test]
    fn 损坏默认定价不丢失其它设置() {
        let directory = super::super::wallpaper::tests::TestDirectory::new();
        fs::write(
            directory.0.join("settings.json"),
            r#"{
            "terminal":{"fontSize":19}, "wallpaper":{"opacity":72},
            "docker":{"defaultImage":"tdc/test:custom"},
            "defaultPricing":{"modelPricing":null}
        }"#,
        )
        .unwrap();
        let settings = ConfigStore::load(directory.0.clone()).settings();
        assert_eq!(settings.terminal.font_size, 19);
        assert_eq!(settings.wallpaper.opacity, 72);
        assert_eq!(settings.docker.default_image, "tdc/test:custom");
        assert_eq!(settings.default_pricing, Default::default());
    }

    #[test]
    fn 壁纸随设置保存重新加载且取消草稿不影响当前资源() {
        let directory = super::super::wallpaper::tests::TestDirectory::new();
        let store = ConfigStore::load(directory.0.join("config"));
        let source = directory.image("saved.png");
        let asset = store.import_wallpaper(&source, WallpaperKind::Image).unwrap();
        let mut settings = store.settings();
        settings.wallpaper.asset = Some(asset.clone());
        settings.wallpaper.glass_blur = 24;
        settings.wallpaper.terminal_opacity = 0;
        store.set_settings(settings.clone()).unwrap();
        assert!(store.delete_wallpaper(&asset.file_name).is_err());
        let draft = store.import_wallpaper(&source, WallpaperKind::Image).unwrap();
        store.delete_wallpaper(&draft.file_name).unwrap();
        fs::remove_file(source).unwrap();
        let reloaded = ConfigStore::load(directory.0.join("config"));
        assert_eq!(reloaded.settings().wallpaper, settings.wallpaper);
        assert!(reloaded.resolve_wallpaper(&asset.file_name).is_ok());
        assert!(reloaded.delete_wallpaper(&asset.file_name).is_err());
        let mut cleared = reloaded.settings();
        cleared.wallpaper.asset = None;
        reloaded.set_settings(cleared).unwrap();
        reloaded.delete_wallpaper(&asset.file_name).unwrap();
        assert!(reloaded.resolve_wallpaper(&asset.file_name).is_err());
    }

    #[test]
    fn 无效壁纸设置不能替换已保存设置() {
        let directory = super::super::wallpaper::tests::TestDirectory::new();
        let store = ConfigStore::load(directory.0.clone());
        let mut settings = store.settings();
        settings.terminal.font_size = 18;
        store.set_settings(settings.clone()).unwrap();
        let mut invalid = settings.clone();
        invalid.terminal.font_size = 25;
        invalid.wallpaper.opacity = 101;
        assert!(store.set_settings(invalid).is_err());
        assert_eq!(store.settings().terminal.font_size, 18);
        assert_eq!(ConfigStore::load(directory.0.clone()).settings().terminal.font_size, 18);
    }

    #[test]
    fn 历史配置自动补齐壁纸且损坏壁纸不丢失其它设置() {
        let directory = super::super::wallpaper::tests::TestDirectory::new();
        let path = directory.0.join("settings.json");
        fs::write(&path, r#"{"terminal":{"fontSize":19},"wallpaper":{"fit":"obsolete"}}"#).unwrap();
        let store = ConfigStore::load(directory.0.clone());
        assert_eq!(store.settings().terminal.font_size, 19);
        assert_eq!(store.settings().wallpaper, WallpaperSettings::default());
        fs::write(&path, r#"{"terminal":{"fontSize":20},"wallpaper":{"opacity":240,"glassBlur":90}}"#).unwrap();
        let store = ConfigStore::load(directory.0.clone());
        assert_eq!(store.settings().terminal.font_size, 20);
        assert_eq!(store.settings().wallpaper.opacity, 100);
        assert_eq!(store.settings().wallpaper.glass_blur, 40);
    }

    #[test]
    fn 媒体与配置目录可以分开而不依赖源文件目录() {
        let directory = super::super::wallpaper::tests::TestDirectory::new();
        let config = directory.0.join("config");
        let media = directory.0.join("data").join("wallpapers");
        let store = ConfigStore::load_with_wallpaper_dir(config.clone(), media.clone());
        let asset = store.import_wallpaper(&directory.image("photo.png"), WallpaperKind::Image).unwrap();
        assert!(media.join(&asset.file_name).exists());
        assert!(!config.join("wallpapers").exists());
    }
}
