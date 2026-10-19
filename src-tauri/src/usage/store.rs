//! Append-only usage ledger. Request IDs deduplicate shared histories globally.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use super::model::*;
use crate::config::store::write_json_atomic;
use crate::error::{AppError, AppResult};
use crate::providers::ProviderPricingTable;
use crate::quota::poller::now_secs;

pub struct UsageStore {
    directory: PathBuf,
    data: Mutex<UsageData>,
    pub refresh_lock: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct UsageData {
    records: HashMap<String, UsageRecord>,
    collection: CollectionState,
    load_warnings: Vec<String>,
    load_blocked: bool,
}

impl UsageStore {
    pub fn load(directory: &Path) -> Self {
        let directory = directory.join("usage");
        let mut data = UsageData::default();
        let path = directory.join("requests.jsonl");
        match fs::File::open(&path) {
            Ok(file) => {
                let mut damaged = 0;
                for line in BufReader::new(file).lines() {
                    let line = match line {
                        Ok(line) => line,
                        Err(_) => {
                            data.load_blocked = true;
                            data.load_warnings.push("本地用量文件读取中断；写入已暂停以保护原记录。".into());
                            break;
                        }
                    };
                    match Some(line).filter(|line| !line.trim().is_empty()) {
                        Some(line) => match serde_json::from_str::<UsageRecord>(&line) {
                            Ok(record) if record.validate().is_ok() => {
                                data.records.insert(record.id.clone(), record);
                            }
                            _ => {
                                damaged += 1;
                            }
                        },
                        None => continue,
                    }
                }
                if damaged > 0 {
                    data.load_warnings
                        .push(format!("本地用量文件中 {damaged} 条损坏记录已跳过，原文件保留；其余记录仍可查询。"));
                }
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                data.load_warnings.push("本地用量文件无法读取，当前统计可能不完整。".into());
                data.load_blocked = true;
            }
            Err(_) => {}
        }
        if let Ok(bytes) = fs::read(directory.join("collection.json")) {
            if let Ok(mut state) = serde_json::from_slice::<CollectionState>(&bytes) {
                // A previous process cannot prove that collection is currently active.
                for container in &mut state.containers {
                    container.status = "stopped".into();
                }
                data.collection = state;
            }
        }
        Self { directory, data: Mutex::new(data), refresh_lock: tokio::sync::Mutex::new(()) }
    }

    /// Corrections append before becoming visible; request IDs stay global.
    /// Verified submissions can repair legacy container and provider guesses.
    pub fn ingest(&self, incoming: Vec<UsageRecord>) -> AppResult<usize> {
        let mut data = self.data.lock();
        if data.load_blocked {
            return Err(AppError::Io(
                "本地用量账本无法完整读取，已暂停追加以保护原记录；请修复文件权限后重启应用。".into(),
            ));
        }
        let mut pending = HashMap::<String, UsageRecord>::new();
        for mut record in incoming {
            record.validate()?;
            record.normalize_attribution();
            let previous = pending.get(&record.id).or_else(|| data.records.get(&record.id));
            if let Some(previous) = previous {
                let both_owned =
                    previous.attribution_source == "local-history" && record.attribution_source == "local-history";
                if both_owned && previous.container != record.container {
                    // A second independently evidenced owner is a conflict,
                    // including when its container was unavailable last round.
                    record.attribution = "historical".into();
                    record.attribution_source = "ambiguous".into();
                    record.normalize_attribution();
                } else if previous.attribution_source == "ambiguous"
                    || (record.attribution_source != "ambiguous"
                        && ((previous.attribution_source == "local-history"
                            && (!both_owned || previous.attribution == "captured"))
                            || (previous.attribution_source.is_empty()
                                && record.attribution_source.is_empty()
                                && previous.attribution == "captured")))
                {
                    // Weak rescans cannot undo verified ownership. A confirmed
                    // conflict stays unresolved even if a later scan is partial.
                    // Same-owner captured pricing and tier rules remain frozen.
                    let incoming_counters = record;
                    record = previous.clone();
                    record.merge_counters(&incoming_counters);
                }
                record.merge_counters(previous);
            }
            record.apply_pricing_tier();
            if previous.is_some_and(|previous| &record == previous) {
                continue;
            }
            pending.insert(record.id.clone(), record);
        }
        if pending.is_empty() {
            return Ok(0);
        }
        fs::create_dir_all(&self.directory)?;
        let mut body = Vec::new();
        // A previous interrupted append might have left an unterminated line.
        body.push(b'\n');
        for record in pending.values() {
            serde_json::to_writer(&mut body, record)?;
            body.push(b'\n');
        }
        let mut file = OpenOptions::new().create(true).append(true).open(self.directory.join("requests.jsonl"))?;
        file.write_all(&body)?;
        file.sync_data()?;
        let count = pending.len();
        data.records.extend(pending);
        Ok(count)
    }

    pub fn set_collection(&self, collection: CollectionState) -> AppResult<()> {
        fs::create_dir_all(&self.directory)?;
        write_json_atomic(&self.directory.join("collection.json"), &collection)?;
        self.data.lock().collection = collection;
        Ok(())
    }

    pub fn collection(&self) -> CollectionState {
        self.data.lock().collection.clone()
    }

    pub fn query(&self, query: &UsageQuery) -> AppResult<UsageResult> {
        self.query_with_pricing(query, &ProviderPricingTable::new())
    }

    /// 按请求原供应商的当前价格估算，仅改变查询副本；原账本和归属不变。
    /// 已删除供应商或没有供应商 ID 时，保留请求捕获时的价格。
    pub fn query_with_pricing(&self, query: &UsageQuery, pricing: &ProviderPricingTable) -> AppResult<UsageResult> {
        self.query_with_default_pricing(query, pricing, &crate::providers::DefaultPricing::default().snapshot())
    }

    pub fn query_with_default_pricing(
        &self,
        query: &UsageQuery,
        pricing: &ProviderPricingTable,
        defaults: &crate::providers::ProviderPricing,
    ) -> AppResult<UsageResult> {
        query.validate()?;
        let data = self.data.lock();
        let mut collection = data.collection.clone();
        collection.warnings.extend(data.load_warnings.clone());
        let records: Vec<_> = data
            .records
            .values()
            .filter(|record| query.matches(record))
            .cloned()
            .map(|mut record| {
                if record.attribution == "captured" {
                    let current = match record.auth_type.as_str() {
                        "api" => record.provider_id.as_ref().and_then(|id| pricing.get(id)),
                        "authorization" => Some(defaults),
                        _ => None,
                    };
                    if let Some(current) = current {
                        record.pricing = current.model_pricing.get(&record.model).copied().unwrap_or(current.pricing);
                        record.pricing_tier = current.model_pricing_tiers.get(&record.model).copied();
                        record.apply_pricing_tier();
                    }
                }
                record
            })
            .collect();
        let mut totals = UsageMetrics::default();
        let mut by_container = BTreeMap::<String, UsageMetrics>::new();
        let mut by_day = BTreeMap::<i64, UsageMetrics>::new();
        let bucket_seconds = query.granularity.seconds();
        let offset = query.utc_offset_minutes.unwrap_or(0) as i64 * 60;
        for state in &collection.containers {
            if query.container.as_ref().map_or(true, |s| *s == state.container) {
                by_container.entry(state.container.clone()).or_default();
            }
        }
        for record in &records {
            totals.add(record);
            by_container.entry(record.container.clone()).or_default().add(record);
            by_day.entry((record.timestamp + offset).div_euclid(bucket_seconds)).or_default().add(record);
        }
        let now = now_secs();
        let start =
            query.from.map(|n| (n + offset).div_euclid(bucket_seconds)).or_else(|| by_day.keys().next().copied());
        let end = (query.to.unwrap_or(now + 1) - 1 + offset).div_euclid(bucket_seconds);
        if let Some(start) = start {
            if (0..=3660).contains(&(end - start)) {
                for day in start..=end {
                    by_day.entry(day).or_default();
                }
            } else if end - start > 3660 {
                collection.warnings.push(
                    "时间跨度较大，趋势保留有请求的时段；可缩小日期范围查看连续趋势，总计仍包括完整范围。".into(),
                );
            }
        }
        let containers = by_container
            .into_iter()
            .map(|(container, metrics)| {
                let state =
                    collection.containers.iter().find(|s| s.container == container).cloned().unwrap_or_else(|| {
                        ContainerCollection {
                            container: container.clone(),
                            status: "stopped".into(),
                            ..Default::default()
                        }
                    });
                ContainerUsage { container, metrics, collection: state }
            })
            .collect();
        let trend = by_day
            .into_iter()
            .map(|(bucket, metrics)| UsageTrend {
                date: if bucket_seconds == 3600 {
                    format!("{}T{:02}:00", civil_date(bucket.div_euclid(24)), bucket.rem_euclid(24))
                } else {
                    civil_date(bucket)
                },
                metrics,
            })
            .collect();
        let mut ordered = records;
        ordered.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| a.id.cmp(&b.id)));
        let total_logs = ordered.len();
        let page_size = query.page_size.unwrap_or(25).clamp(1, 200);
        let total_pages = total_logs.div_ceil(page_size).max(1);
        let page = query.page.unwrap_or(1).clamp(1, total_pages);
        let logs =
            ordered.into_iter().skip((page - 1) * page_size).take(page_size).map(|record| record.log()).collect();
        // Options remain available when a filter produces zero matches.
        let mut providers = BTreeMap::new();
        let mut models = BTreeSet::new();
        for record in data.records.values() {
            if let Some(id) = &record.provider_id {
                providers.insert(id.clone(), record.provider_name.clone());
            }
            if !record.model.is_empty() {
                models.insert(record.model.clone());
            }
        }
        if data.records.values().any(|r| r.attribution == "historical" && r.attribution_source != "local-history") {
            collection.warnings.push(
                "部分历史记录缺少本地提交证据或存在归属冲突，记为「未归属（历史）」且成本为 0；不会按扫描顺序猜测归属。"
                    .into(),
            );
        }
        if data.records.values().any(|r| r.attribution == "historical" && r.attribution_source == "local-history") {
            collection.warnings.push("部分请求已确认所属容器，但缺少请求发生时的供应商快照，成本暂记为 0。".into());
        }
        collection.warnings.sort();
        collection.warnings.dedup();
        Ok(UsageResult {
            generated_at: now,
            totals,
            containers,
            trend,
            logs,
            total_logs,
            page,
            page_size,
            providers: providers.into_iter().map(|(id, name)| UsageProvider { id, name }).collect(),
            models: models.into_iter().collect(),
            collection,
        })
    }
}

/// Gregorian date of an epoch day (Howard Hinnant's civil-from-days algorithm).
fn civil_date(day: i64) -> String {
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    format!("{:04}-{:02}-{:02}", y + i64::from(m <= 2), m, d)
}
