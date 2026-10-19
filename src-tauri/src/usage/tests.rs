use super::model::*;
use super::store::UsageStore;
use crate::providers::{LongContextPricing, ProviderProfile, ProviderStore, TokenPricing};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("tdc-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        Self(directory)
    }
    fn store(&self) -> UsageStore {
        UsageStore::load(&self.0)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn record(id: &str) -> UsageRecord {
    UsageRecord {
        id: id.into(),
        timestamp: 1_704_067_200,
        container: "container-a".into(),
        session_id: "session".into(),
        auth_type: "api".into(),
        provider_id: Some("provider-a".into()),
        provider_name: "供应商 A".into(),
        model: "model-a".into(),
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 800,
        cache_write_tokens: 100,
        duration_ms: Some(2000.0),
        pricing: TokenPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
        pricing_tier: None,
        attribution: "captured".into(),
        attribution_source: String::new(),
    }
}

fn provider(pricing: TokenPricing) -> ProviderProfile {
    ProviderProfile {
        id: "provider-a".into(),
        name: "供应商 A".into(),
        base_url: String::new(),
        model: String::new(),
        small_model: String::new(),
        token_env: "ANTHROPIC_API_KEY".into(),
        extra_env: Default::default(),
        pricing,
        model_pricing: Default::default(),
    }
}

fn assert_cost(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-12, "cost {actual} != {expected}");
}

#[test]
fn 后补定价统一重算总览容器趋势和日志且不改原账本() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let providers = ProviderStore::load(&fixture.0).unwrap();
    providers.save(provider(TokenPricing::default()), None).unwrap();
    let mut first = record("exact-model");
    first.pricing = TokenPricing::default();
    let mut second = record("fallback-model");
    second.pricing = TokenPricing::default();
    second.model = "MODEL-A".into(); // 模型覆盖精确匹配，大小写不同使用默认费率。
    second.container = "container-b".into();
    second.timestamp += 86_400;
    store.ingest(vec![first.clone(), second.clone()]).unwrap();
    let path = fixture.0.join("usage/requests.jsonl");
    let ledger_before = std::fs::read(&path).unwrap();
    let query = UsageQuery { from: Some(first.timestamp), to: Some(second.timestamp + 86_400), ..Default::default() };
    assert_eq!(store.query_with_pricing(&query, &providers.pricing_snapshot()).unwrap().totals.cost_usd, 0.0);

    let default = TokenPricing { input: 2.0, output: 4.0, cache_read: 0.5, cache_write: 2.5 };
    let model = TokenPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 };
    let mut updated = provider(default);
    updated.model_pricing.insert("model-a".into(), model);
    providers.save(updated, None).unwrap();
    let result = store.query_with_pricing(&query, &providers.pricing_snapshot()).unwrap();

    assert_eq!(result.totals.requests, 2);
    assert_eq!(result.totals.total_tokens, 2040);
    assert_eq!(result.total_logs, 2);
    assert_eq!(result.containers.len(), 2);
    assert_eq!(result.trend.len(), 2);
    assert_cost(result.totals.cost_usd, 0.002145);
    for (source, pricing, expected) in [(&first, model, 0.001215), (&second, default, 0.00093)] {
        let log = result.logs.iter().find(|log| log.record.id == source.id).unwrap();
        assert_eq!(log.record.pricing, pricing);
        assert_cost(log.cost_usd, expected);
        assert_cost(log.record.cost_usd(), expected);
        let mut original = log.record.clone();
        original.pricing = source.pricing;
        assert_eq!(original, *source);
        let container = result.containers.iter().find(|row| row.container == source.container).unwrap();
        assert_eq!(container.metrics.requests, 1);
        assert_cost(container.metrics.cost_usd, expected);
    }
    assert_cost(result.trend[0].metrics.cost_usd, 0.001215);
    assert_cost(result.trend[1].metrics.cost_usd, 0.00093);
    assert_eq!(std::fs::read(&path).unwrap(), ledger_before);
    assert_eq!(store.query(&query).unwrap().totals.cost_usd, 0.0);
    let reloaded = fixture.store().query(&query).unwrap();
    assert_eq!(reloaded.totals.cost_usd, 0.0);
    assert!(reloaded.logs.iter().all(|log| log.record.pricing == TokenPricing::default()));
}

#[test]
fn 再次保存定价立即重算且始终使用请求原供应商() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let providers = ProviderStore::load(&fixture.0).unwrap();
    let original = record("request");
    store.ingest(vec![original.clone()]).unwrap();
    let query = UsageQuery { provider_id: Some("provider-a".into()), ..Default::default() };
    let mut configured = provider(TokenPricing { input: 2.0, ..Default::default() });
    providers.save(configured.clone(), None).unwrap();
    let mut other = provider(TokenPricing { input: 99.0, ..Default::default() });
    other.id = "provider-b".into();
    other.name = "供应商 B".into();
    providers.save(other, None).unwrap();
    providers.bind("container-a", Some("provider-b")).unwrap();

    let before = store.query_with_pricing(&query, &providers.pricing_snapshot()).unwrap();
    assert_cost(before.totals.cost_usd, 0.0002);
    configured.pricing.input = 5.0;
    providers.save(configured, None).unwrap();
    let after = store.query_with_pricing(&query, &providers.pricing_snapshot()).unwrap();
    assert_cost(after.totals.cost_usd, 0.0005);
    assert_eq!(after.logs[0].record.provider_id, original.provider_id);
    assert_eq!(after.logs[0].record.container, original.container);
    assert_eq!(after.logs[0].record.pricing.input, 5.0);
    assert_eq!(after.providers[0].name, original.provider_name);
    assert_eq!(store.query(&query).unwrap().logs[0].record, original);
}

#[test]
fn 零价模型覆盖默认且未知模型授权采用默认回退价格() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let providers = ProviderStore::load(&fixture.0).unwrap();
    let mut configured = provider(TokenPricing { input: 99.0, ..Default::default() });
    configured.model_pricing.insert("model-a".into(), TokenPricing::default());
    providers.save(configured, None).unwrap();
    let known = record("zero-model");
    let mut authorization = record("authorization");
    authorization.auth_type = "authorization".into();
    let mut historical = record("historical");
    historical.attribution = "historical".into();
    let mut unknown = record("unknown-auth");
    unknown.auth_type = "unknown".into();
    let mut deleted = record("deleted-provider");
    deleted.provider_id = Some("provider-deleted".into());
    let mut no_provider = record("no-provider");
    no_provider.provider_id = None;
    store.ingest(vec![known, authorization.clone(), historical, unknown, deleted.clone(), no_provider]).unwrap();
    let path = fixture.0.join("usage/requests.jsonl");
    let ledger_before = std::fs::read(&path).unwrap();
    let result = store.query_with_pricing(&UsageQuery::default(), &providers.pricing_snapshot()).unwrap();
    assert_eq!(result.totals.requests, 6);
    assert_cost(result.totals.cost_usd, 0.00243);
    for id in ["zero-model", "authorization", "historical", "unknown-auth"] {
        assert_eq!(result.logs.iter().find(|log| log.record.id == id).unwrap().cost_usd, 0.0);
    }
    for id in ["deleted-provider", "no-provider"] {
        let log = result.logs.iter().find(|log| log.record.id == id).unwrap();
        assert_eq!(log.record.pricing, deleted.pricing);
        assert_cost(log.cost_usd, 0.001215);
    }
    authorization.pricing = TokenPricing::default();
    assert_eq!(result.logs.iter().find(|log| log.record.id == "authorization").unwrap().record, authorization);
    let historical = &result.logs.iter().find(|log| log.record.id == "historical").unwrap().record;
    assert_eq!(historical.container, "未归属（历史）");
    assert_eq!(historical.provider_id, None);
    assert_eq!(historical.pricing, TokenPricing::default());
    assert_eq!(std::fs::read(&path).unwrap(), ledger_before);
}

#[test]
fn 当前定价查询保持筛选和分页且汇总包含全部匹配请求() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let providers = ProviderStore::load(&fixture.0).unwrap();
    providers.save(provider(TokenPricing { input: 10.0, ..Default::default() }), None).unwrap();
    let first = record("first");
    let mut second = record("second");
    second.timestamp += 1;
    let mut excluded = record("excluded");
    excluded.container = "container-b".into();
    store.ingest(vec![first, second, excluded]).unwrap();
    let result = store
        .query_with_pricing(
            &UsageQuery {
                container: Some("container-a".into()),
                page: Some(2),
                page_size: Some(1),
                ..Default::default()
            },
            &providers.pricing_snapshot(),
        )
        .unwrap();
    assert_eq!(result.total_logs, 2);
    assert_eq!(result.logs.len(), 1);
    assert_eq!(result.logs[0].record.id, "first");
    assert_eq!(result.totals.requests, 2);
    assert_eq!(result.containers.len(), 1);
    assert_cost(result.totals.cost_usd, 0.002);
    assert_cost(result.containers[0].metrics.cost_usd, 0.002);
    assert_cost(result.logs[0].cost_usd, 0.001);
    assert_eq!(result.logs[0].record.pricing.input, 10.0);
}

#[test]
fn 当前价格保留模型别名覆盖和长上下文阈值() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let providers = ProviderStore::load(&fixture.0).unwrap();
    let mut configured = provider(TokenPricing::default());
    let custom = TokenPricing { input: 7.0, ..Default::default() };
    configured.model_pricing.insert("claude-sonnet-4-5-20250929".into(), custom);
    configured.model_pricing.insert("claude-sonnet-4-5".into(), TokenPricing::default());
    providers.save(configured.clone(), None).unwrap();
    let mut standard = record("at-threshold");
    standard.model = "claude-haiku-5-5".into();
    standard.input_tokens = 50_000;
    standard.cache_read_tokens = 49_999;
    standard.cache_write_tokens = 1;
    standard.output_tokens = 10;
    let mut long = standard.clone();
    long.id = "above-threshold".into();
    long.cache_read_tokens += 1;
    long.pricing_tier = Some(LongContextPricing {
        input_tokens_threshold: 1,
        pricing: TokenPricing { input: 99.0, ..Default::default() },
    });
    let mut canonical = record("canonical");
    canonical.model = "claude-sonnet-4-5-20250929".into();
    let mut alias = record("alias");
    alias.model = "claude-sonnet-4-5".into();
    store.ingest(vec![standard, long, canonical, alias]).unwrap();

    let result = store.query_with_pricing(&UsageQuery::default(), &providers.pricing_snapshot()).unwrap();
    let standard = result.logs.iter().find(|log| log.record.id == "at-threshold").unwrap();
    assert_eq!(standard.record.pricing.input, 0.1);
    assert_cost(standard.cost_usd, 0.005505115);
    let long = result.logs.iter().find(|log| log.record.id == "above-threshold").unwrap();
    assert_eq!(long.record.pricing.input, 0.5);
    assert_cost(long.cost_usd, 0.027525625);
    assert_eq!(result.logs.iter().find(|log| log.record.id == "canonical").unwrap().record.pricing, custom);
    assert_eq!(result.logs.iter().find(|log| log.record.id == "alias").unwrap().cost_usd, 0.0);

    configured.model_pricing.insert("claude-haiku-5-5".into(), custom);
    providers.save(configured, None).unwrap();
    let updated = store.query_with_pricing(&UsageQuery::default(), &providers.pricing_snapshot()).unwrap();
    for id in ["at-threshold", "above-threshold"] {
        let record = &updated.logs.iter().find(|log| log.record.id == id).unwrap().record;
        assert_eq!(record.pricing, custom);
        assert_eq!(record.pricing_tier, None);
    }
    let original = store.query(&UsageQuery::default()).unwrap();
    let original = &original.logs.iter().find(|log| log.record.id == "above-threshold").unwrap().record;
    assert_eq!(original.pricing.input, 99.0);
    assert_eq!(original.pricing_tier.unwrap().input_tokens_threshold, 1);
}

fn tiered_capture(id: &str, input: u64, read: u64, write: u64) -> UsageRecord {
    let snapshot = serde_json::from_value(serde_json::json!({
        "protocol": 2,
        "supported": true,
        "captureReady": true,
        "captureStartedAt": 1_700_000_000,
        "provider": {
            "authType": "api",
            "providerId": "provider-a",
            "modelPricing": {
                "claude-haiku-5-5": { "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125 }
            },
            "modelPricingTiers": {
                "claude-haiku-5-5": {
                    "inputTokensThreshold": 100_000,
                    "pricing": { "input": 0.5, "output": 2.5, "cacheRead": 0.05, "cacheWrite": 0.625 }
                }
            }
        },
        "records": [{
            "id": id,
            "timestamp": 1_704_067_200,
            "model": "claude-haiku-5-5",
            "inputTokens": input,
            "outputTokens": 2,
            "cacheReadTokens": read,
            "cacheWriteTokens": write,
            "attribution": "captured",
            "ownership": "local-history"
        }]
    }))
    .unwrap();
    let (mut records, invalid) = super::collector::to_records("container-a", "api", &snapshot);
    assert_eq!(invalid, 0);
    assert_eq!(records.len(), 1);
    records.pop().unwrap()
}

#[test]
fn 价格按百万计算且已知授权可估算而未知历史不计费() {
    let mut request = record("r");
    assert!((request.cost_usd() - 0.001215).abs() < 1e-12);
    assert_eq!(request.log().speed, Some(10.0));
    assert_eq!(request.total_tokens(), 1020);
    request.auth_type = "authorization".into();
    assert_cost(request.cost_usd(), 0.001215);
    request.auth_type = "api".into();
    request.attribution = "historical".into();
    assert_eq!(request.cost_usd(), 0.0);
    request.duration_ms = None;
    assert_eq!(request.log().speed, None);
}

#[test]
fn 缓存命中率使用加权输入量包含缓存写入() {
    let mut first = record("a");
    let mut second = record("b");
    first.input_tokens = 0;
    first.cache_read_tokens = 10;
    first.cache_write_tokens = 0;
    second.input_tokens = 90;
    second.cache_read_tokens = 0;
    second.cache_write_tokens = 0;
    let mut metrics = UsageMetrics::default();
    metrics.add(&first);
    metrics.add(&second);
    assert_eq!(metrics.cache_hit_rate, 0.1);
}

#[test]
fn 同请求跨容器重复只计一次且后续调价不改历史快照() {
    let fixture = Fixture::new();
    let store = fixture.store();
    assert_eq!(store.ingest(vec![record("same")]).unwrap(), 1);
    let mut duplicate = record("same");
    duplicate.container = "container-b".into();
    duplicate.provider_id = Some("provider-b".into());
    duplicate.pricing.input = 100.0;
    duplicate.output_tokens = 30;
    assert_eq!(store.ingest(vec![duplicate]).unwrap(), 1);
    assert_eq!(store.ingest(vec![record("same")]).unwrap(), 0);
    let result = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.logs[0].record.container, "container-a");
    assert_eq!(result.logs[0].record.provider_id.as_deref(), Some("provider-a"));
    assert_eq!(result.logs[0].record.pricing.input, 3.0);
    assert_eq!(result.logs[0].record.output_tokens, 30);
    assert_eq!(fixture.store().query(&UsageQuery::default()).unwrap().totals.requests, 1);
}

#[test]
fn 同批采集补全输入和缓存后按冻结阶梯晋档() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let first = tiered_capture("same", 99_999, 1, 0);
    let later = tiered_capture("same", 0, 1, 1);
    let tier = first.pricing_tier.unwrap();
    // Both partial snapshots use the base rate; only their merged input crosses
    // the threshold, so pricing must be selected again after merging counters.
    assert_eq!(first.pricing.input, 0.1);
    assert_eq!(later.pricing.input, 0.1);
    assert_eq!(store.ingest(vec![first, later]).unwrap(), 1);
    let result = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.logs[0].record.input_tokens, 99_999);
    assert_eq!(result.logs[0].record.cache_read_tokens, 1);
    assert_eq!(result.logs[0].record.cache_write_tokens, 1);
    assert_eq!(result.logs[0].record.pricing, tier.pricing);
    assert_eq!(result.logs[0].record.pricing_tier, Some(tier));
}

#[test]
fn 跨批重载后补全输入仍使用首次冻结的阈值和费率() {
    let fixture = Fixture::new();
    let first = tiered_capture("same", 99_999, 1, 0);
    let tier = first.pricing_tier.unwrap();
    fixture.store().ingest(vec![first]).unwrap();

    let store = fixture.store();
    assert_eq!(store.query(&UsageQuery::default()).unwrap().logs[0].record.pricing.input, 0.1);
    let mut later = tiered_capture("same", 100_000, 0, 0);
    later.pricing = TokenPricing { input: 4.0, output: 8.0, cache_read: 0.4, cache_write: 5.0 };
    later.pricing_tier = Some(LongContextPricing {
        input_tokens_threshold: 200_000,
        pricing: TokenPricing { input: 20.0, output: 100.0, cache_read: 2.0, cache_write: 25.0 },
    });
    assert_eq!(store.ingest(vec![later.clone()]).unwrap(), 1);
    assert_eq!(store.ingest(vec![later]).unwrap(), 0);

    let result = fixture.store().query(&UsageQuery::default()).unwrap();
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.logs[0].record.input_tokens, 100_000);
    assert_eq!(result.logs[0].record.cache_read_tokens, 1);
    assert_eq!(result.logs[0].record.pricing_tier, Some(tier));
    assert_eq!(result.logs[0].record.pricing, tier.pricing);
    assert!((result.logs[0].cost_usd - 0.05000505).abs() < 1e-12);
}

#[test]
fn 旧账本缺少阶梯时后续采集不能注入新规则() {
    let fixture = Fixture::new();
    let mut old = tiered_capture("same", 100_000, 0, 0);
    old.pricing_tier = None;
    let frozen = old.pricing;
    fixture.store().ingest(vec![old]).unwrap();
    let ledger = std::fs::read_to_string(fixture.0.join("usage/requests.jsonl")).unwrap();
    assert!(!ledger.contains("pricingTier"));

    let store = fixture.store();
    assert_eq!(store.ingest(vec![tiered_capture("same", 100_001, 0, 0)]).unwrap(), 1);
    let result = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(result.logs[0].record.input_tokens, 100_001);
    assert_eq!(result.logs[0].record.pricing_tier, None);
    assert_eq!(result.logs[0].record.pricing, frozen);
}

#[test]
fn 历史未知归属升级为可信快照但不能降级() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut old = record("same");
    old.attribution = "historical".into();
    old.pricing_tier = Some(LongContextPricing { input_tokens_threshold: 1, pricing: old.pricing });
    store.ingest(vec![old.clone()]).unwrap();
    let first = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(first.logs[0].record.container, "未归属（历史）");
    assert_eq!(first.logs[0].record.auth_type, "unknown");
    assert_eq!(first.logs[0].cost_usd, 0.0);
    assert_eq!(first.logs[0].record.pricing_tier, None);
    store.ingest(vec![record("same")]).unwrap();
    assert_eq!(store.ingest(vec![old]).unwrap(), 0);
    let final_result = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(final_result.totals.requests, 1);
    assert_eq!(final_result.logs[0].record.container, "container-a");
    assert!(final_result.logs[0].cost_usd > 0.0);
}

#[test]
fn 同批次去重不会增加请求数() {
    let fixture = Fixture::new();
    let store = fixture.store();
    assert_eq!(store.ingest(vec![record("a"), record("a"), record("b")]).unwrap(), 2);
    assert_eq!(store.query(&UsageQuery::default()).unwrap().totals.requests, 2);
}

#[test]
fn 日期半开区间及本地日趋势() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut first = record("first");
    first.timestamp = 1_704_124_800; // 2024-01-01 16:00 UTC = Jan 2 in UTC+8
    let mut second = record("second");
    second.timestamp = first.timestamp + 86_400;
    store.ingest(vec![first.clone(), second.clone()]).unwrap();
    let result = store
        .query(&UsageQuery {
            from: Some(first.timestamp),
            to: Some(second.timestamp),
            utc_offset_minutes: Some(480),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.trend.len(), 1);
    assert_eq!(result.trend[0].date, "2024-01-02");
    let leap =
        store.query(&UsageQuery { from: Some(1_709_164_800), to: Some(1_709_251_200), ..Default::default() }).unwrap();
    assert_eq!(leap.trend[0].date, "2024-02-29");
    assert_eq!(leap.totals.requests, 0);
}

#[test]
fn 分页排序和所有过滤器组合() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut list = Vec::new();
    for index in 0..5 {
        let mut entry = record(&format!("r{index}"));
        entry.timestamp += index;
        list.push(entry);
    }
    let mut unrelated = record("unrelated");
    unrelated.container = "container-b".into();
    list.push(unrelated);
    store.ingest(list).unwrap();
    let result = store
        .query(&UsageQuery {
            container: Some("container-a".into()),
            auth_type: Some("api".into()),
            provider_id: Some("provider-a".into()),
            model: Some("model-a".into()),
            page: Some(2),
            page_size: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.total_logs, 5);
    assert_eq!(result.logs.len(), 2);
    assert_eq!(result.logs[0].record.id, "r2");
    assert_eq!(result.totals.requests, 5);
    assert_eq!(result.containers.len(), 1);
    let clamped =
        store.query(&UsageQuery { page: Some(usize::MAX), page_size: Some(2), ..Default::default() }).unwrap();
    assert_eq!(clamped.page, 3);
}

#[test]
fn 无用量的现有容器也有零值卡片() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store
        .set_collection(CollectionState {
            containers: vec![ContainerCollection {
                container: "empty".into(),
                status: "active".into(),
                last_collected_at: Some(12),
                error: None,
                capture_ready: false,
            }],
            ..Default::default()
        })
        .unwrap();
    let result = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(result.containers.len(), 1);
    assert_eq!(result.containers[0].metrics.requests, 0);
}

#[test]
fn 坏行保留且重启读回有效记录() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store.ingest(vec![record("a")]).unwrap();
    let path = fixture.0.join("usage/requests.jsonl");
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{broken").unwrap();
    let reloaded = fixture.store();
    assert_eq!(reloaded.query(&UsageQuery::default()).unwrap().totals.requests, 1);
    assert!(!reloaded.query(&UsageQuery::default()).unwrap().collection.warnings.is_empty());
    reloaded.ingest(vec![record("b")]).unwrap();
    assert_eq!(fixture.store().query(&UsageQuery::default()).unwrap().totals.requests, 2);
    assert!(std::fs::read_to_string(path).unwrap().contains("{broken"));
}

#[test]
fn 无效记录和日期不落盘() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut invalid = record("a");
    invalid.pricing.input = -1.0;
    assert!(store.ingest(vec![invalid]).is_err());
    let mut invalid_tier = record("b");
    invalid_tier.pricing_tier = Some(LongContextPricing {
        input_tokens_threshold: 100_000,
        pricing: TokenPricing { input: -1.0, ..Default::default() },
    });
    assert!(store.ingest(vec![invalid_tier]).is_err());
    assert!(!fixture.0.join("usage/requests.jsonl").exists());
    assert!(store.query(&UsageQuery { from: Some(10), to: Some(9), ..Default::default() }).is_err());
    assert!(store.query(&UsageQuery { utc_offset_minutes: Some(900), ..Default::default() }).is_err());
}

#[test]
fn 账本仅保存元数据() {
    let value = serde_json::json!({"id":"a","timestamp":1704067200,"container":"a","authType":"api",
        "model":"model-a","inputTokens":1,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0,
        "attribution":"captured","messages":[{"content":"DO_NOT_STORE"}],"apiKey":"SECRET"});
    let request: UsageRecord = serde_json::from_value(value).unwrap();
    let fixture = Fixture::new();
    fixture.store().ingest(vec![request]).unwrap();
    let ledger = std::fs::read_to_string(fixture.0.join("usage/requests.jsonl")).unwrap();
    assert!(!ledger.contains("DO_NOT_STORE"));
    assert!(!ledger.contains("SECRET"));
}

fn owned_request(id: &str, container: &str) -> UsageRecord {
    let mut request = record(id);
    request.container = container.into();
    request.attribution_source = "local-history".into();
    request
}

#[test]
fn 本地提交证据追加纠正旧容器和供应商且重载后不反弹() {
    let fixture = Fixture::new();
    let mut old = record("same");
    old.output_tokens = 30;
    fixture.store().ingest(vec![old.clone()]).unwrap();
    let path = fixture.0.join("usage/requests.jsonl");
    let original = std::fs::read_to_string(&path).unwrap();
    assert!(!original.contains("attributionSource"));

    let store = fixture.store();
    let mut corrected = owned_request("same", "container-b");
    corrected.provider_id = Some("provider-b".into());
    corrected.provider_name = "供应商 B".into();
    corrected.pricing.input = 9.0;
    assert_eq!(store.ingest(vec![corrected.clone()]).unwrap(), 1);
    let result = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(result.total_logs, 1);
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.totals.total_tokens, old.total_tokens());
    let repaired = &result.logs[0].record;
    assert_eq!(repaired.container, "container-b");
    assert_eq!(repaired.provider_id.as_deref(), Some("provider-b"));
    assert_eq!(repaired.pricing.input, 9.0);
    assert_eq!(repaired.attribution_source, "local-history");
    assert!(std::fs::read_to_string(path).unwrap().starts_with(&original));

    let reloaded = fixture.store();
    assert_eq!(reloaded.ingest(vec![old, corrected]).unwrap(), 0);
    assert_eq!(reloaded.query(&UsageQuery::default()).unwrap().logs[0].record, *repaired);
}

#[test]
fn 同批旧来源与本地证据合并顺序不改变归属或重复计数() {
    let old = record("same");
    let verified = owned_request("same", "container-b");
    for batch in [vec![old.clone(), verified.clone()], vec![verified, old]] {
        let fixture = Fixture::new();
        let store = fixture.store();
        assert_eq!(store.ingest(batch).unwrap(), 1);
        let result = store.query(&UsageQuery::default()).unwrap();
        assert_eq!(result.totals.requests, 1);
        assert_eq!(result.logs[0].record.container, "container-b");
        assert_eq!(result.logs[0].record.attribution_source, "local-history");
    }
}

#[test]
fn 无归属证据的扫描仍能补全计数但不能降级已证来源() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let verified = owned_request("same", "container-b");
    store.ingest(vec![verified.clone()]).unwrap();
    let mut observer = record("same");
    observer.attribution = "historical".into();
    observer.attribution_source = "unverified".into();
    observer.output_tokens = 40;
    assert_eq!(store.ingest(vec![observer.clone()]).unwrap(), 1);
    assert_eq!(store.ingest(vec![observer]).unwrap(), 0);
    let result = fixture.store().query(&UsageQuery::default()).unwrap();
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.logs[0].record.container, "container-b");
    assert_eq!(result.logs[0].record.attribution_source, "local-history");
    assert_eq!(result.logs[0].record.pricing, verified.pricing);
    assert_eq!(result.logs[0].record.output_tokens, 40);
}

#[test]
fn 多批本地证据冲突保持未归属且后续漏采不能恢复猜测() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store.ingest(vec![owned_request("same", "container-a")]).unwrap();
    let other = owned_request("same", "container-b");
    assert_eq!(store.ingest(vec![other.clone()]).unwrap(), 1);
    let result = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.logs[0].record.attribution_source, "ambiguous");
    assert_eq!(result.logs[0].record.container, "未归属（历史）");
    assert_eq!(result.logs[0].cost_usd, 0.0);
    let reloaded = fixture.store();
    assert_eq!(reloaded.ingest(vec![other]).unwrap(), 0);
    assert_eq!(reloaded.query(&UsageQuery::default()).unwrap().logs[0].record.attribution_source, "ambiguous");
}

#[test]
fn 完整批次的可信冲突可撤销之前的单来源归属() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let first = owned_request("same", "container-a");
    store.ingest(vec![first.clone()]).unwrap();
    let conflict = super::collector::resolve_records(vec![first, owned_request("same", "container-b")]);
    assert_eq!(store.ingest(conflict).unwrap(), 1);
    let result = fixture.store().query(&UsageQuery::default()).unwrap();
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.logs[0].record.attribution_source, "ambiguous");
    assert_eq!(result.logs[0].record.container, "未归属（历史）");
}

#[test]
fn 新扫描无证据时旧时间猜测归零但请求和token不丢失() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let old = record("same");
    store.ingest(vec![old.clone()]).unwrap();
    let mut unknown = old.clone();
    unknown.attribution = "historical".into();
    unknown.attribution_source = "unverified".into();
    store.ingest(vec![unknown]).unwrap();
    let result = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(result.totals.requests, 1);
    assert_eq!(result.totals.total_tokens, old.total_tokens());
    assert_eq!(result.logs[0].record.container, "未归属（历史）");
    assert_eq!(result.logs[0].cost_usd, 0.0);
    store.ingest(vec![owned_request("same", "container-b")]).unwrap();
    assert_eq!(store.query(&UsageQuery::default()).unwrap().logs[0].record.container, "container-b");
}

#[test]
fn 仅有容器证据时保留容器而不套用未知供应商价格() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut unknown_price = owned_request("same", "container-b");
    unknown_price.attribution = "historical".into();
    unknown_price.pricing_tier = Some(LongContextPricing { input_tokens_threshold: 1, pricing: unknown_price.pricing });
    store.ingest(vec![unknown_price]).unwrap();
    let result = store.query(&UsageQuery::default()).unwrap();
    let saved = &result.logs[0].record;
    assert_eq!(saved.container, "container-b");
    assert_eq!(saved.provider_id, None);
    assert_eq!(saved.pricing_tier, None);
    assert_eq!(saved.cost_usd(), 0.0);
    assert_eq!(saved.attribution_source, "local-history");
    assert!(result.collection.warnings.iter().any(|warning| warning.contains("已确认所属容器")));
    store.ingest(vec![owned_request("same", "container-b")]).unwrap();
    let upgraded = store.query(&UsageQuery::default()).unwrap();
    assert_eq!(upgraded.logs[0].record.attribution, "captured");
    assert!(upgraded.logs[0].cost_usd > 0.0);
}

#[test]
fn 不接受无证据却声明精确采集的记录() {
    let mut invalid = record("same");
    invalid.attribution_source = "unverified".into();
    let fixture = Fixture::new();
    assert!(fixture.store().ingest(vec![invalid]).is_err());
    assert!(!fixture.0.join("usage/requests.jsonl").exists());
}

#[test]
fn 授权默认定价重算历史费用并保留归属与原账本() {
    use crate::providers::{DefaultPricing, ProviderPricingTable};
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut captured = record("subscription");
    captured.auth_type = "authorization".into();
    captured.provider_id = None;
    captured.model = "claude-sonnet-4-6".into();
    captured.pricing = TokenPricing::default();
    let mut unknown = captured.clone();
    unknown.id = "unknown".into();
    unknown.attribution = "historical".into();
    store.ingest(vec![captured.clone(), unknown]).unwrap();
    let ledger = fixture.0.join("usage/requests.jsonl");
    let before = std::fs::read(&ledger).unwrap();
    let query = UsageQuery {
        from: Some(captured.timestamp),
        to: Some(captured.timestamp + 3600),
        granularity: UsageGranularity::Hour,
        ..Default::default()
    };
    let mut prices = DefaultPricing::default();
    let first = store.query_with_default_pricing(&query, &ProviderPricingTable::new(), &prices.snapshot()).unwrap();
    assert!(first.totals.cost_usd > 0.0);
    prices
        .model_pricing
        .insert(captured.model.clone(), TokenPricing { input: 10.0, output: 20.0, cache_read: 1.0, cache_write: 12.0 });
    let result = store.query_with_default_pricing(&query, &ProviderPricingTable::new(), &prices.snapshot()).unwrap();
    assert_cost(result.totals.cost_usd, 0.0034);
    assert_cost(result.trend[0].metrics.cost_usd, result.totals.cost_usd);
    let log = result.logs.iter().find(|log| log.record.id == "subscription").unwrap();
    assert_cost(log.cost_usd, result.totals.cost_usd);
    assert_eq!(log.record.provider_id, None);
    assert_eq!(log.record.auth_type, "authorization");
    assert_eq!(result.logs.iter().find(|log| log.record.id == "unknown").unwrap().cost_usd, 0.0);
    prices.model_pricing.insert(captured.model, TokenPricing::default());
    assert_eq!(
        store
            .query_with_default_pricing(&query, &ProviderPricingTable::new(), &prices.snapshot())
            .unwrap()
            .totals
            .cost_usd,
        0.0
    );
    assert_eq!(std::fs::read(ledger).unwrap(), before);
}

#[test]
fn 小时趋势采用本地时区半开区间且不受日志分页影响() {
    let fixture = Fixture::new();
    let store = fixture.store();
    // 2024-01-01 15:00 UTC = 23:00 UTC+8. Exercise both hour and day boundaries.
    let from = 1_704_067_200 + 15 * 3600;
    let times = [from - 1, from, from + 3599, from + 3600, from + 3 * 3600];
    store
        .ingest(
            times
                .into_iter()
                .enumerate()
                .map(|(i, timestamp)| {
                    let mut value = record(&format!("hour-{i}"));
                    value.timestamp = timestamp;
                    value
                })
                .collect(),
        )
        .unwrap();
    let query = UsageQuery {
        from: Some(from),
        to: Some(from + 3 * 3600),
        utc_offset_minutes: Some(480),
        granularity: UsageGranularity::Hour,
        page_size: Some(1),
        ..Default::default()
    };
    let hourly = store.query(&query).unwrap();
    assert_eq!(hourly.logs.len(), 1);
    assert_eq!(hourly.total_logs, 3);
    assert_eq!(
        hourly.trend.iter().map(|point| point.date.as_str()).collect::<Vec<_>>(),
        ["2024-01-01T23:00", "2024-01-02T00:00", "2024-01-02T01:00"]
    );
    assert_eq!(hourly.trend.iter().map(|point| point.metrics.requests).collect::<Vec<_>>(), [2, 1, 0]);
    let daily = store.query(&UsageQuery { granularity: UsageGranularity::Day, ..query }).unwrap();
    assert_eq!(daily.trend.len(), 2);
    assert_eq!(daily.totals.total_tokens, hourly.totals.total_tokens);
    assert_cost(daily.totals.cost_usd, hourly.totals.cost_usd);
}
