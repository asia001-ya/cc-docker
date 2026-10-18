//! Container-side usage collection.
//!
//! Claude Code keeps request usage in its session JSONL files.  The desktop
//! process never reads those files directly: it asks each managed container to
//! run the bundled read-only collector and emit a metadata-only snapshot, then stores the
//! records in the append-only [`UsageStore`].  This keeps prompts, responses,
//! credentials and other transcript content inside the container.

use std::collections::HashMap;

use serde::Deserialize;

use crate::docker::client::{DockerClient, ExecOutput};
use crate::providers::{LongContextPricing, TokenPricing};
use crate::quota::poller::now_secs;

use super::model::{CollectionState, ContainerCollection, UsageRecord};
use super::store::UsageStore;

const USAGE_SCRIPT: &str = concat!(
    include_str!("../../../docker/rootfs/opt/tdc/tdc-usage.mjs"),
    "\nconsole.log(JSON.stringify(collectUsage({configDir:process.env.CLAUDE_CONFIG_DIR || \"/home/node/.claude\"})));"
);
const USAGE_COMMAND: [&str; 4] = ["node", "--input-type=module", "--eval", USAGE_SCRIPT];

/// JSON emitted by `tdc-ctl usage`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct UsageSnapshot {
    protocol: u32,
    supported: bool,
    capture_ready: bool,
    capture_started_at: Option<i64>,
    provider: Option<ProviderSnapshot>,
    records: Vec<UsageSnapshotRecord>,
    warnings: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ProviderSnapshot {
    auth_type: String,
    provider_id: Option<String>,
    provider_name: String,
    pricing: TokenPricing,
    model_pricing: HashMap<String, TokenPricing>,
    model_pricing_tiers: HashMap<String, LongContextPricing>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct UsageSnapshotRecord {
    id: String,
    timestamp: i64,
    #[serde(alias = "session_id")]
    session_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    duration_ms: Option<f64>,
    attribution: String,
    ownership: String,
}

#[derive(Debug)]
pub(crate) enum SnapshotError {
    Unsupported(String),
    Failed(String),
}

/// Parse the last non-empty JSON line from `tdc-ctl usage` output.
///
/// This is kept separate from Docker I/O so the wire format can be tested and
/// remains tolerant of harmless shell output before the JSON payload.
pub(crate) fn parse_snapshot(output: &ExecOutput) -> Result<UsageSnapshot, SnapshotError> {
    let line = output.stdout.lines().rev().find(|line| !line.trim().is_empty());
    let Some(line) = line else {
        return Err(if output.exit_code == Some(0) {
            SnapshotError::Failed("用量采集命令没有输出".into())
        } else {
            SnapshotError::Unsupported("容器无法运行用量采集器，请确认镜像已安装 Node.js".into())
        });
    };
    match serde_json::from_str::<UsageSnapshot>(line) {
        Ok(snapshot) if [1, 2].contains(&snapshot.protocol) && snapshot.supported => Ok(snapshot),
        Ok(_) => Err(SnapshotError::Unsupported("容器镜像不支持用量采集协议".into())),
        Err(error) if output.exit_code != Some(0) => {
            Err(SnapshotError::Unsupported(format!("容器无法运行用量采集器：{error}")))
        }
        Err(error) => Err(SnapshotError::Failed(format!("用量采集输出无法解析：{error}"))),
    }
}

fn auth_type(provider: Option<&ProviderSnapshot>, fallback: &str) -> String {
    let value = provider.map(|p| p.auth_type.as_str()).unwrap_or_default();
    match value {
        "api" | "authorization" | "unknown" => value.to_string(),
        _ if fallback == "api" => "api".into(),
        _ => "authorization".into(),
    }
}

pub(super) fn to_records(container: &str, fallback_auth: &str, snapshot: &UsageSnapshot) -> (Vec<UsageRecord>, usize) {
    let provider = snapshot.provider.as_ref();
    let auth_type = auth_type(provider, fallback_auth);
    let provider_id = provider.and_then(|p| p.provider_id.clone());
    let provider_name = provider.map(|p| p.provider_name.clone()).unwrap_or_default();
    let default_pricing = provider.map(|p| p.pricing).unwrap_or_default();
    let mut invalid = 0;
    let mut records = Vec::with_capacity(snapshot.records.len());
    for row in &snapshot.records {
        let owned = snapshot.protocol == 2 && row.ownership == "local-history";
        let priced = owned
            && row.attribution == "captured"
            && snapshot.capture_ready
            && snapshot.provider.is_some()
            && snapshot.capture_started_at.is_some_and(|started| row.timestamp >= started);
        let base_pricing = provider.and_then(|p| p.model_pricing.get(&row.model).copied()).unwrap_or(default_pricing);
        // Read the frozen launch snapshot only: a newer bundled catalog must not
        // change the price of requests collected from an older snapshot.
        let pricing_tier = provider.and_then(|p| p.model_pricing_tiers.get(&row.model).copied());
        let mut record = UsageRecord {
            id: row.id.clone(),
            timestamp: row.timestamp,
            container: container.to_string(),
            session_id: row.session_id.clone(),
            auth_type: auth_type.clone(),
            provider_id: provider_id.clone(),
            provider_name: provider_name.clone(),
            model: row.model.clone(),
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            cache_read_tokens: row.cache_read_tokens,
            cache_write_tokens: row.cache_write_tokens,
            duration_ms: row.duration_ms,
            pricing: base_pricing,
            pricing_tier,
            attribution: if priced { "captured".into() } else { "historical".into() },
            attribution_source: if owned { "local-history".into() } else { "unverified".into() },
        };
        record.normalize_attribution();
        record.apply_pricing_tier();
        if record.validate().is_ok() {
            records.push(record);
        } else {
            invalid += 1;
        }
    }
    (records, invalid)
}

/// Resolve shared transcript copies before writing any of them. Container
/// enumeration order must never decide who owns a request.
pub(super) fn resolve_records(incoming: Vec<UsageRecord>) -> Vec<UsageRecord> {
    let mut groups = std::collections::BTreeMap::<String, Vec<UsageRecord>>::new();
    for record in incoming {
        groups.entry(record.id.clone()).or_default().push(record);
    }
    groups
        .into_values()
        .map(|records| {
            let owners: std::collections::BTreeSet<_> = records
                .iter()
                .filter(|record| record.attribution_source == "local-history")
                .map(|record| record.container.as_str())
                .collect();
            let selected = records
                .iter()
                .find(|record| record.attribution_source == "local-history" && record.attribution == "captured")
                .or_else(|| records.iter().find(|record| record.attribution_source == "local-history"))
                .unwrap_or(&records[0]);
            let mut record = selected.clone();
            if owners.len() != 1 {
                record.attribution = "historical".into();
                record.attribution_source = if owners.len() > 1 { "ambiguous".into() } else { "unverified".into() };
                record.normalize_attribution();
            }
            for duplicate in &records {
                record.merge_counters(duplicate);
            }
            record.apply_pricing_tier();
            record
        })
        .collect()
}

fn previous_for<'a>(state: &'a CollectionState, name: &str) -> Option<&'a ContainerCollection> {
    state.containers.iter().find(|container| container.container == name)
}

fn base_state(previous: &CollectionState, name: &str) -> ContainerCollection {
    previous_for(previous, name).cloned().unwrap_or_else(|| ContainerCollection {
        container: name.to_string(),
        status: "stopped".into(),
        last_collected_at: None,
        error: None,
        capture_ready: false,
    })
}

async fn collect_container(
    docker: &DockerClient,
    container: &crate::docker::client::ContainerInfo,
    previous: &CollectionState,
    now: i64,
) -> (ContainerCollection, Vec<UsageRecord>, Vec<String>) {
    let mut state = base_state(previous, &container.name);
    if !container.running {
        state.status = "stopped".into();
        state.error = None;
        return (state, Vec::new(), Vec::new());
    }

    let output = match docker.exec(&container.name, &USAGE_COMMAND, None).await {
        Ok(output) => output,
        Err(error) => {
            state.status = "error".into();
            state.error = Some(error.to_string());
            return (state, Vec::new(), Vec::new());
        }
    };
    let snapshot = match parse_snapshot(&output) {
        Ok(snapshot) => snapshot,
        Err(SnapshotError::Unsupported(error)) => {
            state.status = "unsupported".into();
            state.error = Some(error);
            state.capture_ready = false;
            return (state, Vec::new(), Vec::new());
        }
        Err(SnapshotError::Failed(error)) => {
            state.status = "error".into();
            state.error = Some(error);
            return (state, Vec::new(), Vec::new());
        }
    };

    let (records, invalid) = to_records(&container.name, &container.auth_mode, &snapshot);
    state.status = "active".into();
    state.last_collected_at = Some(now);
    state.error = None;
    state.capture_ready = snapshot.capture_ready;
    let mut warnings = snapshot.warnings;
    if invalid > 0 {
        warnings.push(format!("{} 条用量记录字段无效，已跳过。", invalid));
    }
    if let Some(started) = snapshot.capture_started_at {
        if started > now + 300 {
            warnings.push("容器报告的采集启用时间超前，已按历史记录处理异常记录。".into());
        }
    }
    (state, records, warnings)
}

/// Refresh all managed containers.  Collection errors are reflected in the
/// per-container state and deliberately do not fail the UI refresh command.
pub async fn refresh(docker: Option<&DockerClient>, store: &UsageStore) {
    let _guard = store.refresh_lock.lock().await;
    let Some(docker) = docker else { return };
    let now = now_secs();
    let previous = store.collection();
    let containers = match docker.list(false).await {
        Ok(containers) => containers,
        Err(error) => {
            let mut collection = previous;
            collection.warnings.push(format!("无法列出容器，用量采集未刷新：{error}"));
            collection.warnings.sort();
            collection.warnings.dedup();
            let _ = store.set_collection(collection);
            return;
        }
    };

    let mut states = Vec::with_capacity(containers.len());
    let mut incoming = Vec::new();
    let mut warnings = Vec::new();
    for container in &containers {
        let (state, records, mut container_warnings) = collect_container(docker, container, &previous, now).await;
        states.push(state);
        incoming.extend(records);
        warnings.append(&mut container_warnings);
    }
    if !incoming.is_empty() {
        if let Err(error) = store.ingest(resolve_records(incoming)) {
            warnings.push(format!("用量账本写入失败：{error}"));
        }
    }
    let mut collection = CollectionState { last_collected_at: Some(now), containers: states, warnings };
    collection.warnings.sort();
    collection.warnings.dedup();
    let _ = store.set_collection(collection);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(body: &str, code: Option<i64>) -> ExecOutput {
        ExecOutput { stdout: body.into(), stderr: String::new(), exit_code: code }
    }

    #[test]
    fn 采集协议解析并选择模型覆盖价格() {
        let body = r#"{"protocol":2,"supported":true,"captureReady":true,"captureStartedAt":1700000000,"provider":{"authType":"api","providerId":"p","providerName":"Relay","pricing":{"input":3,"output":15},"modelPricing":{"claude-opus":{"input":5,"output":25}}},"records":[{"id":"s:r","timestamp":1700000001,"sessionId":"s","model":"claude-opus","inputTokens":2,"outputTokens":3,"attribution":"captured","ownership":"local-history"}]}"#;
        let snapshot = parse_snapshot(&output(body, Some(0))).unwrap();
        let (records, invalid) = to_records("c", "subscription", &snapshot);
        assert_eq!(invalid, 0);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pricing.input, 5.0);
        assert_eq!(records[0].auth_type, "api");
        assert_eq!(records[0].attribution, "captured");
    }

    fn tiered_snapshot() -> UsageSnapshot {
        serde_json::from_value(serde_json::json!({
            "protocol": 2,
            "supported": true,
            "captureReady": true,
            "captureStartedAt": 1_700_000_000,
            "provider": {
                "authType": "api",
                "modelPricing": {
                    "claude-haiku-5-5": { "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125 }
                },
                "modelPricingTiers": {
                    "claude-haiku-5-5": {
                        "inputTokensThreshold": 100_000,
                        "pricing": { "input": 0.5, "output": 2.5, "cacheRead": 0.05, "cacheWrite": 0.625 }
                    }
                }
            }
        }))
        .unwrap()
    }

    fn usage_row(input: u64, output: u64, read: u64, write: u64) -> UsageSnapshotRecord {
        UsageSnapshotRecord {
            id: "s:r".into(),
            timestamp: 1_700_000_001,
            model: "claude-haiku-5-5".into(),
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: read,
            cache_write_tokens: write,
            attribution: "captured".into(),
            ownership: "local-history".into(),
            ..Default::default()
        }
    }

    #[test]
    fn 长上下文严格超过输入阈值才切换全部费率() {
        let mut snapshot = tiered_snapshot();
        snapshot.records = vec![usage_row(100_000, 1_000_000, 0, 0), usage_row(100_001, 2, 0, 0)];
        let (records, invalid) = to_records("c", "api", &snapshot);

        assert_eq!(invalid, 0);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].pricing, TokenPricing { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });
        assert_eq!(records[1].pricing, TokenPricing { input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625 });
    }

    #[test]
    fn 缓存读取和写入均计入长上下文输入阈值() {
        let mut snapshot = tiered_snapshot();
        snapshot.records = vec![
            usage_row(1, 2, 99_999, 0),
            usage_row(1, 2, 100_000, 0),
            usage_row(1, 2, 0, 100_000),
            usage_row(1, 2, 50_000, 50_000),
        ];
        let (records, invalid) = to_records("c", "api", &snapshot);

        assert_eq!(invalid, 0);
        assert_eq!(records.len(), 4);
        assert_eq!(records[0].pricing.input, 0.1);
        let tier = TokenPricing { input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625 };
        for record in &records[1..] {
            assert_eq!(record.pricing, tier);
        }
        assert!((records[3].cost_usd() - 0.0337555).abs() < 1e-12);
    }

    #[test]
    fn 长上下文阈值和费率均只使用快照中的值() {
        let mut snapshot = tiered_snapshot();
        let frozen_pricing = TokenPricing { input: 7.0, output: 11.0, cache_read: 13.0, cache_write: 17.0 };
        snapshot.provider.as_mut().unwrap().model_pricing_tiers.insert(
            "claude-haiku-5-5".into(),
            LongContextPricing { input_tokens_threshold: 7, pricing: frozen_pricing },
        );
        snapshot.records = vec![usage_row(8, 2, 0, 0)];
        let (records, invalid) = to_records("c", "api", &snapshot);
        assert_eq!(invalid, 0);
        assert_eq!(records[0].pricing, frozen_pricing);
    }

    #[test]
    fn 旧快照缺少阶梯价格时保留原模型定价() {
        let mut body = serde_json::json!({
            "protocol": 2,
            "supported": true,
            "captureReady": true,
            "captureStartedAt": 1_700_000_000,
            "provider": {
                "authType": "api",
                "pricing": { "input": 3, "output": 15 },
                "modelPricing": {
                    "claude-haiku-5-5": { "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125 }
                }
            }
        });
        let mut snapshot: UsageSnapshot = serde_json::from_value(body.clone()).unwrap();
        assert!(snapshot.provider.as_ref().unwrap().model_pricing_tiers.is_empty());
        snapshot.records = vec![usage_row(100_001, 2, 3, 4)];
        let (records, invalid) = to_records("c", "api", &snapshot);
        assert_eq!(invalid, 0);
        assert_eq!(records[0].pricing, TokenPricing { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });

        // Old snapshots without model overrides must retain their provider's
        // fixed fallback even when the model has a bundled official price now.
        body["provider"].as_object_mut().unwrap().remove("modelPricing");
        let mut snapshot: UsageSnapshot = serde_json::from_value(body).unwrap();
        snapshot.records = vec![usage_row(100_001, 2, 3, 4)];
        let (records, invalid) = to_records("c", "api", &snapshot);
        assert_eq!(invalid, 0);
        assert_eq!(records[0].pricing, TokenPricing { input: 3.0, output: 15.0, ..Default::default() });
    }

    #[test]
    fn 超大输入计数不会在选择阶梯时溢出() {
        let mut snapshot = tiered_snapshot();
        snapshot.records = vec![usage_row(u64::MAX, 2, u64::MAX, u64::MAX)];
        let (records, invalid) = to_records("c", "api", &snapshot);
        assert!(records.is_empty());
        assert_eq!(invalid, 1);
    }

    #[test]
    fn 老镜像非零退出视为不支持() {
        let error = parse_snapshot(&output("usage: tdc-ctl ...", Some(1))).unwrap_err();
        assert!(matches!(error, SnapshotError::Unsupported(_)));
    }

    #[test]
    fn 旧协议不能仅凭快照时间声称请求属于扫描容器() {
        let mut snapshot = tiered_snapshot();
        snapshot.protocol = 1;
        snapshot.records = vec![usage_row(10, 2, 0, 0)];
        let (records, invalid) = to_records("claude-01", "api", &snapshot);
        assert_eq!(invalid, 0);
        assert_eq!(records[0].attribution_source, "unverified");
        assert_eq!(records[0].attribution, "historical");
        assert_eq!(records[0].container, "未归属（历史）");
        assert_eq!(records[0].provider_id, None);
        assert_eq!(records[0].cost_usd(), 0.0);
    }

    #[test]
    fn 本地归属证据与请求时定价证据分别验证() {
        let mut snapshot = tiered_snapshot();
        snapshot.records = vec![usage_row(10, 2, 0, 0)];
        for boundary in [None, Some(1_700_000_002)] {
            snapshot.capture_started_at = boundary;
            let (records, invalid) = to_records("claude-02", "api", &snapshot);
            assert_eq!(invalid, 0);
            assert_eq!(records[0].container, "claude-02");
            assert_eq!(records[0].attribution_source, "local-history");
            assert_eq!(records[0].attribution, "historical");
            assert_eq!(records[0].provider_id, None);
            assert_eq!(records[0].cost_usd(), 0.0);
        }
        snapshot.capture_started_at = Some(1_700_000_001);
        let (records, _) = to_records("claude-02", "api", &snapshot);
        assert_eq!(records[0].attribution, "captured");
    }

    #[test]
    fn 共享请求按本地提交证据归属且扫描顺序不影响结果() {
        let mut snapshot = tiered_snapshot();
        snapshot.records = vec![usage_row(10, 2, 0, 0)];
        let owner = to_records("claude-02", "api", &snapshot).0.remove(0);
        snapshot.records[0].ownership = "unverified".into();
        snapshot.records[0].output_tokens = 5;
        let observer = to_records("claude-01", "api", &snapshot).0.remove(0);
        let forward = resolve_records(vec![observer.clone(), owner.clone()]);
        let backward = resolve_records(vec![owner, observer]);
        assert_eq!(forward, backward);
        assert_eq!(forward.len(), 1);
        assert_eq!(forward[0].container, "claude-02");
        assert_eq!(forward[0].attribution_source, "local-history");
        assert_eq!(forward[0].output_tokens, 5);
    }

    #[test]
    fn 多个本地提交来源冲突不按扫描先后猜测() {
        let mut snapshot = tiered_snapshot();
        snapshot.records = vec![usage_row(10, 2, 0, 0)];
        let first = to_records("claude-01", "api", &snapshot).0.remove(0);
        let second = to_records("claude-02", "api", &snapshot).0.remove(0);
        for incoming in [vec![first.clone(), second.clone()], vec![second, first]] {
            let records = resolve_records(incoming);
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].container, "未归属（历史）");
            assert_eq!(records[0].attribution_source, "ambiguous");
            assert_eq!(records[0].cost_usd(), 0.0);
        }
    }
}
