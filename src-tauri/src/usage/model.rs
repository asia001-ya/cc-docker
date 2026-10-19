//! Usage IPC DTOs. Transcripts and credentials are deliberately absent.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::providers::{LongContextPricing, TokenPricing};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub timestamp: i64,
    pub container: String,
    #[serde(default)]
    pub session_id: String,
    pub auth_type: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_name: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    #[serde(default)]
    pub pricing: TokenPricing,
    /// Frozen with the first captured request; retained when later scans fill
    /// in token counts so a request can cross its original context threshold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing_tier: Option<LongContextPricing>,
    pub attribution: String,
    /// Container ownership evidence. Empty means a legacy mtime-only inference.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub attribution_source: String,
}

impl UsageRecord {
    pub fn validate(&self) -> AppResult<()> {
        if self.id.is_empty()
            || self.id.len() > 512
            || self.container.len() > 512
            || self.model.len() > 512
            || self.provider_name.len() > 512
            || self.session_id.len() > 512
            || !(0..=253_402_300_799).contains(&self.timestamp)
            || !["api", "authorization", "unknown"].contains(&self.auth_type.as_str())
            || !["captured", "historical"].contains(&self.attribution.as_str())
            || !["", "local-history", "unverified", "ambiguous"].contains(&self.attribution_source.as_str())
            || (["unverified", "ambiguous"].contains(&self.attribution_source.as_str())
                && self.attribution != "historical")
        {
            return Err(AppError::Invalid("用量记录元数据无效".into()));
        }
        self.pricing.validate()?;
        if let Some(tier) = self.pricing_tier {
            tier.pricing.validate()?;
        }
        if [self.input_tokens, self.output_tokens, self.cache_read_tokens, self.cache_write_tokens]
            .iter()
            .any(|n| *n > 1_000_000_000_000)
            || !self.cost_usd().is_finite()
            || self.duration_ms.is_some_and(|n| !n.is_finite() || n <= 0.0)
        {
            return Err(AppError::Invalid("用量记录 token、价格或耗时无效".into()));
        }
        Ok(())
    }

    /// A local submission identifies the container even when request-time
    /// provider settings cannot be established. Unknown pricing stays zero.
    pub(crate) fn normalize_attribution(&mut self) {
        if self.attribution == "historical" {
            if self.attribution_source != "local-history" {
                self.container = "未归属（历史）".into();
            }
            self.auth_type = "unknown".into();
            self.provider_id = None;
            self.provider_name.clear();
            self.pricing = Default::default();
            self.pricing_tier = None;
        }
    }

    pub(crate) fn merge_counters(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.max(other.input_tokens);
        self.output_tokens = self.output_tokens.max(other.output_tokens);
        self.cache_read_tokens = self.cache_read_tokens.max(other.cache_read_tokens);
        self.cache_write_tokens = self.cache_write_tokens.max(other.cache_write_tokens);
        self.duration_ms = other.duration_ms.or(self.duration_ms);
    }

    /// Usage counters are merged monotonically, so crossing a frozen threshold
    /// can only promote the existing price; old records without a tier stay fixed.
    pub(crate) fn apply_pricing_tier(&mut self) {
        let total_input = self.input_tokens as u128 + self.cache_read_tokens as u128 + self.cache_write_tokens as u128;
        if let Some(tier) = self.pricing_tier.filter(|tier| total_input > tier.input_tokens_threshold as u128) {
            self.pricing = tier.pricing;
        }
    }

    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens
    }

    pub fn cost_usd(&self) -> f64 {
        if matches!(self.auth_type.as_str(), "api" | "authorization") && self.attribution == "captured" {
            self.pricing.cost(self.input_tokens, self.output_tokens, self.cache_read_tokens, self.cache_write_tokens)
        } else {
            0.0
        }
    }

    pub fn log(&self) -> UsageLog {
        UsageLog {
            record: self.clone(),
            total_tokens: self.total_tokens(),
            cost_usd: self.cost_usd(),
            speed: self.duration_ms.map(|ms| self.output_tokens as f64 / (ms / 1000.0)).filter(|n| n.is_finite()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLog {
    #[serde(flatten)]
    pub record: UsageRecord,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub speed: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMetrics {
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub cache_hit_rate: f64,
}

impl UsageMetrics {
    pub fn add(&mut self, record: &UsageRecord) {
        self.requests += 1;
        self.input_tokens += record.input_tokens;
        self.output_tokens += record.output_tokens;
        self.cache_read_tokens += record.cache_read_tokens;
        self.cache_write_tokens += record.cache_write_tokens;
        self.total_tokens += record.total_tokens();
        self.cost_usd += record.cost_usd();
        let input = self.input_tokens + self.cache_read_tokens + self.cache_write_tokens;
        self.cache_hit_rate = if input == 0 { 0.0 } else { self.cache_read_tokens as f64 / input as f64 };
    }
}

#[derive(Debug, Default, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UsageGranularity {
    #[default]
    Day,
    Hour,
}

impl UsageGranularity {
    pub fn seconds(self) -> i64 {
        match self {
            Self::Day => 86_400,
            Self::Hour => 3600,
        }
    }
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageQuery {
    pub granularity: UsageGranularity,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub container: Option<String>,
    pub auth_type: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub page: Option<usize>,
    pub page_size: Option<usize>,
    pub utc_offset_minutes: Option<i32>,
}

impl UsageQuery {
    pub fn validate(&self) -> AppResult<()> {
        if self.from.is_some_and(|n| !(0..=253_402_300_799).contains(&n))
            || self.to.is_some_and(|n| !(1..=253_402_300_800).contains(&n))
            || self.from.zip(self.to).is_some_and(|(from, to)| from >= to)
            || self.utc_offset_minutes.is_some_and(|n| !(-840..=840).contains(&n))
            || self.auth_type.as_ref().is_some_and(|s| !["api", "authorization", "unknown"].contains(&s.as_str()))
        {
            return Err(AppError::Invalid("用量筛选的时间范围、时区或授权类型无效".into()));
        }
        Ok(())
    }

    pub fn matches(&self, record: &UsageRecord) -> bool {
        self.from.map_or(true, |n| record.timestamp >= n)
            && self.to.map_or(true, |n| record.timestamp < n)
            && self.container.as_ref().map_or(true, |s| *s == record.container)
            && self.auth_type.as_ref().map_or(true, |s| *s == record.auth_type)
            && self.provider_id.as_ref().map_or(true, |s| record.provider_id.as_ref() == Some(s))
            && self.model.as_ref().map_or(true, |s| *s == record.model)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerCollection {
    pub container: String,
    pub status: String,
    pub last_collected_at: Option<i64>,
    pub error: Option<String>,
    /// 容器是否存在桌面端写入的来源快照；旧镜像或尚未启用的容器为 false。
    #[serde(default)]
    pub capture_ready: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionState {
    pub last_collected_at: Option<i64>,
    pub containers: Vec<ContainerCollection>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUsage {
    pub container: String,
    pub metrics: UsageMetrics,
    pub collection: ContainerCollection,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageTrend {
    pub date: String,
    pub metrics: UsageMetrics,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageProvider {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResult {
    pub generated_at: i64,
    pub totals: UsageMetrics,
    pub containers: Vec<ContainerUsage>,
    pub trend: Vec<UsageTrend>,
    pub logs: Vec<UsageLog>,
    pub total_logs: usize,
    pub page: usize,
    pub page_size: usize,
    pub providers: Vec<UsageProvider>,
    pub models: Vec<String>,
    pub collection: CollectionState,
}
