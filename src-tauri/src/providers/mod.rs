//! API 供应商（CC Switch 风格）：名称 / Base URL / 模型存 providers.json，Token 存 Windows 凭据管理器。
//!
//! 应用到容器 = 写入容器内 /home/node/.claude/tdc/provider-settings.json 的 env 块，
//! 容器内 claude 包装入口每次启动时添加 `--settings <该文件>`；订阅模式写入空 env。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::config::store::write_json_atomic;
use crate::error::{AppError, AppResult};

mod pricing;
pub use pricing::LongContextPricing;
#[cfg(test)]
mod pricing_tests;

/// 凭据管理器中的服务名。
const KEYRING_SERVICE: &str = "tht-docker-claude";

/// USD / 一百万 token；没有填写的费率为零。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenPricing {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl TokenPricing {
    pub fn validate(&self) -> AppResult<()> {
        if [self.input, self.output, self.cache_read, self.cache_write]
            .iter()
            .any(|v| !v.is_finite() || !(0.0..=1_000_000.0).contains(v))
        {
            return Err(AppError::Invalid("定价必须在 0 到 1,000,000 之间（USD / 百万 token）".into()));
        }
        Ok(())
    }

    pub fn cost(&self, input: u64, output: u64, read: u64, write: u64) -> f64 {
        (input as f64 / 1_000_000.0) * self.input
            + (output as f64 / 1_000_000.0) * self.output
            + (read as f64 / 1_000_000.0) * self.cache_read
            + (write as f64 / 1_000_000.0) * self.cache_write
    }
}

/// 查询时使用的当前费率，不含供应商凭据、环境变量或容器绑定。
#[derive(Debug, Clone, Default)]
pub struct ProviderPricing {
    pub pricing: TokenPricing,
    pub model_pricing: HashMap<String, TokenPricing>,
    pub model_pricing_tiers: HashMap<String, LongContextPricing>,
}

pub type ProviderPricingTable = HashMap<String, ProviderPricing>;

/// Editable reference prices for captured subscription usage, independent of API providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DefaultPricing {
    pub pricing: TokenPricing,
    pub model_pricing: HashMap<String, TokenPricing>,
}

impl Default for DefaultPricing {
    fn default() -> Self {
        let mut model_pricing = HashMap::new();
        pricing::fill_missing(&mut model_pricing);
        Self { pricing: TokenPricing::default(), model_pricing }
    }
}

impl DefaultPricing {
    pub fn normalize(&mut self) {
        pricing::fill_missing(&mut self.model_pricing);
    }

    pub fn validate(&self) -> AppResult<()> {
        self.pricing.validate()?;
        for (model, price) in &self.model_pricing {
            if model.trim().is_empty() || model.len() > 512 || model.chars().any(char::is_control) {
                return Err(AppError::Invalid("默认定价的模型 ID 无效".into()));
            }
            price.validate()?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> ProviderPricing {
        let (model_pricing, model_pricing_tiers) = pricing::snapshot_prices(&self.model_pricing);
        ProviderPricing { pricing: self.pricing, model_pricing, model_pricing_tiers }
    }
}

/// 供应商配置（不含 Token）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    /// 唯一 ID
    pub id: String,
    /// 显示名
    pub name: String,
    /// ANTHROPIC_BASE_URL（空表示官方 API）
    #[serde(default)]
    pub base_url: String,
    /// ANTHROPIC_MODEL（空表示不覆盖）
    #[serde(default)]
    pub model: String,
    /// ANTHROPIC_SMALL_FAST_MODEL / 辅助模型（空表示不覆盖）
    #[serde(default)]
    pub small_model: String,
    /// Token 环境变量名：ANTHROPIC_AUTH_TOKEN（Bearer）或 ANTHROPIC_API_KEY（x-api-key）
    #[serde(default = "default_token_env")]
    pub token_env: String,
    /// 额外环境变量
    #[serde(default)]
    pub extra_env: HashMap<String, String>,
    /// 当前默认费率；统计按请求原供应商的当前价格估算，账本保留捕获时费率。
    #[serde(default)]
    pub pricing: TokenPricing,
    /// 内置 Claude 模型费率与自定义覆盖；已知别名在启动快照中展开。
    #[serde(default)]
    pub model_pricing: HashMap<String, TokenPricing>,
}

/// 默认 Token 变量名。参数：无；返回：ANTHROPIC_AUTH_TOKEN。
fn default_token_env() -> String {
    "ANTHROPIC_AUTH_TOKEN".into()
}

/// 前端展示用视图（附带是否已保存 Token）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    /// 配置
    #[serde(flatten)]
    pub profile: ProviderProfile,
    /// 凭据管理器中是否存在 Token
    pub has_token: bool,
}

/// 持久化文件结构。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvidersFile {
    providers: Vec<ProviderProfile>,
    /// 容器名 → 当前绑定的供应商 ID（容器标签不可修改，故在应用侧记录）
    #[serde(default)]
    bindings: HashMap<String, String>,
}

/// 供应商存储。
pub struct ProviderStore {
    path: PathBuf,
    data: Mutex<ProvidersFile>,
}

impl ProviderStore {
    /// 从配置目录加载。参数：dir——应用配置目录；返回：存储。
    pub fn load(dir: &std::path::Path) -> AppResult<Self> {
        let path = dir.join("providers.json");
        // A failed read must never turn an existing configuration into an
        // empty file when the automatic pricing migration is persisted.
        let mut data: ProvidersFile = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ProvidersFile::default(),
            Err(error) => return Err(error.into()),
        };
        let mut changed = false;
        for provider in &mut data.providers {
            changed |= pricing::fill_missing(&mut provider.model_pricing);
        }
        if changed {
            write_json_atomic(&path, &data)?;
        }
        Ok(Self { path, data: Mutex::new(data) })
    }

    /// 列出供应商。参数：无；返回：视图列表。
    pub fn list(&self) -> Vec<ProviderView> {
        self.data
            .lock()
            .providers
            .iter()
            .map(|p| ProviderView { has_token: read_token(&p.id).is_ok(), profile: p.clone() })
            .collect()
    }

    /// 读取单个供应商。参数：id——供应商 ID；返回：配置或 NotFound。
    pub fn get(&self, id: &str) -> AppResult<ProviderProfile> {
        self.data
            .lock()
            .providers
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("供应商 {id}")))
    }

    /// 在同一次查询中使用一致的费率表，无需访问凭据管理器或运行中的容器。
    pub fn pricing_snapshot(&self) -> ProviderPricingTable {
        self.data
            .lock()
            .providers
            .iter()
            .map(|provider| {
                let (model_pricing, model_pricing_tiers) = pricing::snapshot_prices(&provider.model_pricing);
                (provider.id.clone(), ProviderPricing { pricing: provider.pricing, model_pricing, model_pricing_tiers })
            })
            .collect()
    }

    /// 新增或更新供应商；token 为 Some 时同时写入凭据管理器。
    /// 参数：profile——配置；token——Token（None 表示不修改）；返回：保存后的配置。
    pub fn save(&self, mut profile: ProviderProfile, token: Option<String>) -> AppResult<ProviderProfile> {
        pricing::fill_missing(&mut profile.model_pricing);
        profile.pricing.validate()?;
        for (model, pricing) in &profile.model_pricing {
            if model.trim().is_empty() {
                return Err(AppError::Invalid("模型定价的模型名不能为空".into()));
            }
            pricing.validate()?;
        }
        if profile.name.trim().is_empty() {
            return Err(AppError::Invalid("供应商名称不能为空".into()));
        }
        if !profile.base_url.is_empty() && !profile.base_url.starts_with("http") {
            return Err(AppError::Invalid("Base URL 需以 http:// 或 https:// 开头".into()));
        }
        if profile.token_env != "ANTHROPIC_API_KEY" {
            profile.token_env = default_token_env();
        }
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        }
        if let Some(t) = token.filter(|t| !t.trim().is_empty()) {
            keyring::Entry::new(KEYRING_SERVICE, &profile.id)?.set_password(t.trim())?;
        }
        let mut g = self.data.lock();
        match g.providers.iter_mut().find(|p| p.id == profile.id) {
            Some(slot) => *slot = profile.clone(),
            None => g.providers.push(profile.clone()),
        }
        write_json_atomic(&self.path, &*g)?;
        Ok(profile)
    }

    /// 删除供应商及其 Token。参数：id——供应商 ID；返回：成功与否。
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut g = self.data.lock();
        if g.bindings.values().any(|v| v == id) {
            return Err(AppError::Invalid("仍有容器使用该供应商，请先切回订阅模式或改用其他供应商".into()));
        }
        g.providers.retain(|p| p.id != id);
        write_json_atomic(&self.path, &*g)?;
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, id) {
            let _ = entry.delete_credential();
        }
        Ok(())
    }

    /// 记录容器绑定。参数：container——容器名；provider_id——None 表示订阅模式；返回：成功与否。
    pub fn bind(&self, container: &str, provider_id: Option<&str>) -> AppResult<()> {
        let mut g = self.data.lock();
        match provider_id {
            Some(id) => g.bindings.insert(container.to_string(), id.to_string()),
            None => g.bindings.remove(container),
        };
        write_json_atomic(&self.path, &*g)
    }

    /// 查询容器绑定的供应商。参数：container——容器名；返回：供应商 ID。
    pub fn binding_of(&self, container: &str) -> Option<String> {
        self.data.lock().bindings.get(container).cloned()
    }

    /// 无密钥的启动期计费快照。与 Claude 的 settings 分开保存。
    pub fn render_usage_settings(&self, provider_id: Option<&str>) -> AppResult<Vec<u8>> {
        let value = match provider_id {
            Some(id) => {
                let p = self.get(id)?;
                let (model_pricing, model_pricing_tiers) = pricing::snapshot_prices(&p.model_pricing);
                serde_json::json!({"authType":"api", "providerId":p.id, "providerName":p.name,
                    "pricing":p.pricing, "modelPricing":model_pricing, "modelPricingTiers":model_pricing_tiers})
            }
            None => serde_json::json!({"authType":"authorization", "providerId":null,
                "providerName":"Claude 授权", "pricing":TokenPricing::default(), "modelPricing":{}}),
        };
        Ok(serde_json::to_vec(&value)?)
    }

    pub fn bound_containers(&self, provider_id: &str) -> Vec<String> {
        self.data.lock().bindings.iter().filter(|(_, id)| *id == provider_id).map(|(name, _)| name.clone()).collect()
    }

    /// 生成写入容器的 provider-settings.json 内容。
    /// 参数：provider_id——None 表示订阅模式；返回：JSON 字节。
    pub fn render_settings(&self, provider_id: Option<&str>) -> AppResult<Vec<u8>> {
        let Some(id) = provider_id else {
            return Ok(b"{\n  \"env\": {}\n}\n".to_vec());
        };
        let p = self.get(id)?;
        let token = read_token(id).map_err(|_| AppError::Credential(format!("供应商「{}」未保存 Token", p.name)))?;
        let env = provider_env(&p, &token);
        Ok(serde_json::to_vec_pretty(&serde_json::json!({ "env": env }))?)
    }
}

/// 生成供应商对应的环境变量表。
/// 参数：p——供应商；token——Token；返回：变量表（空值不写入）。
pub fn provider_env(p: &ProviderProfile, token: &str) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = p.extra_env.clone();
    env.insert(p.token_env.clone(), token.to_string());
    if !p.base_url.is_empty() {
        env.insert("ANTHROPIC_BASE_URL".into(), p.base_url.trim_end_matches('/').to_string());
    }
    if !p.model.is_empty() {
        env.insert("ANTHROPIC_MODEL".into(), p.model.clone());
    }
    if !p.small_model.is_empty() {
        env.insert("ANTHROPIC_SMALL_FAST_MODEL".into(), p.small_model.clone());
    }
    env.retain(|k, v| !k.is_empty() && !v.is_empty());
    // Claude Code 的交互界面默认请求 thinking.display="updates"；部分中转
    // 只接受 summarized / omitted。关闭进度扩展，保留正常 thinking 与其他功能。
    // 按最终 URL 判断（也覆盖 extra_env），且尊重供应商显式配置。
    if env
        .get("ANTHROPIC_BASE_URL")
        .is_some_and(|base| !url::Url::parse(base.trim()).is_ok_and(|url| url.host_str() == Some("api.anthropic.com")))
    {
        env.entry("CLAUDE_CODE_THINKING_DISPLAY_UPDATES".into()).or_insert_with(|| "0".into());
    }
    env
}

/// 读取 Token。参数：id——供应商 ID；返回：Token。
fn read_token(id: &str) -> AppResult<String> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, id)?.get_password()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 环境变量映射() {
        let p = ProviderProfile {
            id: "x".into(),
            name: "中转".into(),
            base_url: "https://api.example.com/".into(),
            model: "claude-sonnet-5".into(),
            small_model: String::new(),
            token_env: "ANTHROPIC_AUTH_TOKEN".into(),
            extra_env: HashMap::from([("API_TIMEOUT_MS".into(), "600000".into()), ("EMPTY".into(), String::new())]),
            pricing: TokenPricing::default(),
            model_pricing: HashMap::new(),
        };
        let env = provider_env(&p, "sk-1");
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk-1");
        assert_eq!(env["ANTHROPIC_BASE_URL"], "https://api.example.com");
        assert_eq!(env["ANTHROPIC_MODEL"], "claude-sonnet-5");
        assert!(!env.contains_key("ANTHROPIC_SMALL_FAST_MODEL"));
        assert!(!env.contains_key("EMPTY"));
    }

    fn profile(base_url: &str) -> ProviderProfile {
        serde_json::from_value(serde_json::json!({"id":"test", "name":"Test", "baseUrl":base_url})).unwrap()
    }

    #[test]
    fn 第三方_api_默认禁用不兼容的思考进度扩展() {
        for base in ["https://gateway.example.com", "http://localhost:4000", "https://api.anthropic.com.example.com"] {
            let env = provider_env(&profile(base), "test-token");
            assert_eq!(env["CLAUDE_CODE_THINKING_DISPLAY_UPDATES"], "0");
            assert!(!env.contains_key("CLAUDE_CODE_DISABLE_THINKING"));
            assert!(!env.contains_key("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"));
        }
    }

    #[test]
    fn 官方_api_与订阅保留默认思考进度() {
        for base in ["", "https://api.anthropic.com/", "https://api.anthropic.com:443"] {
            assert!(!provider_env(&profile(base), "test-token").contains_key("CLAUDE_CODE_THINKING_DISPLAY_UPDATES"));
        }
    }

    #[test]
    fn 思考进度兼容设置尊重显式覆盖并使用最终_base_url() {
        let mut p = profile("");
        p.extra_env.insert("ANTHROPIC_BASE_URL".into(), "https://gateway.example.com".into());
        assert_eq!(provider_env(&p, "test-token")["CLAUDE_CODE_THINKING_DISPLAY_UPDATES"], "0");
        for value in ["0", "1"] {
            p.extra_env.insert("CLAUDE_CODE_THINKING_DISPLAY_UPDATES".into(), value.into());
            assert_eq!(provider_env(&p, "test-token")["CLAUDE_CODE_THINKING_DISPLAY_UPDATES"], value);
        }
        p.extra_env.insert("CLAUDE_CODE_THINKING_DISPLAY_UPDATES".into(), String::new());
        assert_eq!(provider_env(&p, "test-token")["CLAUDE_CODE_THINKING_DISPLAY_UPDATES"], "0");
        p.base_url = "https://api.anthropic.com".into();
        assert!(!provider_env(&p, "test-token").contains_key("CLAUDE_CODE_THINKING_DISPLAY_UPDATES"));
    }

    #[test]
    fn 订阅模式写入空_env() {
        let dir = std::env::temp_dir().join(format!("tdc-prov-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = ProviderStore::load(&dir).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&store.render_settings(None).unwrap()).unwrap();
        assert_eq!(v["env"].as_object().unwrap().len(), 0);
        assert!(store
            .save(
                ProviderProfile {
                    id: String::new(),
                    name: " ".into(),
                    base_url: String::new(),
                    model: String::new(),
                    small_model: String::new(),
                    token_env: String::new(),
                    extra_env: HashMap::new(),
                    pricing: TokenPricing::default(),
                    model_pricing: HashMap::new()
                },
                None
            )
            .is_err());
    }
}
