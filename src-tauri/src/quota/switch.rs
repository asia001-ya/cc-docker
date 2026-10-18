//! 额度健康度与热切换候选排序（纯函数，可单测）。
//!
//! 与容器内 /opt/tdc/tdc-lib.mjs 为同一算法，二者共用测试用例
//! docker/tests/fixtures/ranking-cases.json（见本文件测试模块）。

use serde::{Deserialize, Serialize};

use super::model::{Health, QuotaSnapshot, QuotaWindow};
use crate::config::store::QuotaSettings;

/// 参与计算的容器视图。
#[derive(Debug, Clone, Deserialize)]
pub struct QuotaInput {
    /// 容器名
    pub name: String,
    /// 是否运行中
    pub running: bool,
    /// 授权模式：subscription / api
    #[serde(default = "default_mode")]
    pub auth_mode: String,
    /// 额度快照
    #[serde(default)]
    pub quota: Option<QuotaSnapshot>,
    /// 终端输出中检测到限额提示
    #[serde(default)]
    pub limit_hit: bool,
}

/// serde 默认授权模式。参数：无；返回："subscription"。
fn default_mode() -> String {
    "subscription".into()
}

/// 剩余额度计算结果。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Remaining {
    /// 剩余百分比（保留一位小数）
    pub remaining: f64,
    /// 是否包含"重置时间已过 → 推断为 0 已用"的窗口
    pub inferred: bool,
}

/// 热切换候选。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// 容器名
    pub name: String,
    /// 分层：1 运行中有额度 / 2 运行中额度未知 / 3 已停止 / 4 API 兜底
    pub tier: u8,
    /// 剩余百分比
    pub remaining: Option<f64>,
    /// 推荐理由（中文）
    pub reason: String,
}

/// 计算单窗口有效已用百分比：重置时间已过视为 0。
/// 参数：win——窗口；now——当前 epoch 秒；返回：(已用, 是否推断)，无数据返回 None。
pub fn effective_used(win: Option<&QuotaWindow>, now: i64) -> Option<(f64, bool)> {
    let w = win?;
    match w.resets_at {
        Some(r) if now >= r => Some((0.0, true)),
        _ => Some((w.used_percentage, false)),
    }
}

/// 剩余额度 = 100 − max(5h 已用, 周已用)。
/// 参数：quota——额度快照；now——当前 epoch 秒；返回：剩余，两个窗口都无数据返回 None。
pub fn remaining_of(quota: Option<&QuotaSnapshot>, now: i64) -> Option<Remaining> {
    let q = quota?;
    let wins: Vec<(f64, bool)> =
        [q.five_hour.as_ref(), q.seven_day.as_ref()].into_iter().filter_map(|w| effective_used(w, now)).collect();
    if wins.is_empty() {
        return None;
    }
    let used = wins.iter().map(|w| w.0).fold(f64::MIN, f64::max);
    Some(Remaining { remaining: ((100.0 - used) * 10.0).round() / 10.0, inferred: wins.iter().any(|w| w.1) })
}

/// 是否达到切换阈值（任一窗口有效已用 ≥ 阈值）。
/// 参数：quota——额度快照；now——当前时间；threshold——阈值；返回：是否耗尽。
pub fn is_exhausted(quota: Option<&QuotaSnapshot>, now: i64, threshold: f64) -> bool {
    let Some(q) = quota else { return false };
    [q.five_hour.as_ref(), q.seven_day.as_ref()]
        .into_iter()
        .filter_map(|w| effective_used(w, now))
        .any(|(used, _)| used >= threshold)
}

/// 额度恢复时间：所有达到阈值窗口中最晚的 resets_at。
/// 参数：quota——额度快照；now——当前时间；threshold——阈值；返回：epoch 秒或 None。
pub fn blocked_until(quota: Option<&QuotaSnapshot>, now: i64, threshold: f64) -> Option<i64> {
    let q = quota?;
    [q.five_hour.as_ref(), q.seven_day.as_ref()]
        .into_iter()
        .flatten()
        .filter(|w| effective_used(Some(w), now).is_some_and(|(u, _)| u >= threshold))
        .filter_map(|w| w.resets_at)
        .max()
}

/// 计算容器健康状态。
/// 参数：c——容器视图；now——当前时间；s——阈值设置；返回：Health。
pub fn health_of(c: &QuotaInput, now: i64, s: &QuotaSettings) -> Health {
    if !c.running {
        return Health::Stopped;
    }
    if c.auth_mode == "api" {
        return Health::Api;
    }
    if c.limit_hit || is_exhausted(c.quota.as_ref(), now, s.switch_threshold) {
        return Health::Exhausted;
    }
    match remaining_of(c.quota.as_ref(), now) {
        None => Health::Unknown,
        Some(r) if r.remaining > s.warn_threshold => Health::Healthy,
        Some(r) if r.remaining >= s.critical_threshold => Health::Warning,
        Some(_) => Health::Exhausted,
    }
}

/// 生成热切换候选（已排序，第一个为推荐）。
/// 排序：分层升序 → 剩余降序 → 5h 重置早者优先 → 名称。
/// 参数：containers——全部容器；source——源容器名；now——当前时间；s——设置；返回：候选列表。
pub fn rank_candidates(containers: &[QuotaInput], source: &str, now: i64, s: &QuotaSettings) -> Vec<Candidate> {
    let mut rows: Vec<(Candidate, i64)> = Vec::new();
    for c in containers.iter().filter(|c| c.name != source) {
        let rem = remaining_of(c.quota.as_ref(), now);
        let reset5h = c.quota.as_ref().and_then(|q| q.five_hour.as_ref()).and_then(|w| w.resets_at).unwrap_or(i64::MAX);
        let push = |rows: &mut Vec<(Candidate, i64)>, tier: u8, remaining: Option<f64>, reason: String| {
            rows.push((Candidate { name: c.name.clone(), tier, remaining, reason }, reset5h));
        };
        if c.auth_mode == "api" {
            if s.allow_api_fallback && c.running {
                push(&mut rows, 4, None, "API 按量计费兜底".into());
            }
            continue;
        }
        if !c.running {
            if s.include_stopped {
                push(&mut rows, 3, rem.map(|r| r.remaining), "已停止，切换前需启动".into());
            }
            continue;
        }
        if c.limit_hit || is_exhausted(c.quota.as_ref(), now, s.switch_threshold) {
            continue;
        }
        match rem {
            None => push(&mut rows, 2, None, "额度未知（尚无数据）".into()),
            Some(r) if r.remaining > 0.0 => {
                let suffix = if r.inferred { "（推断已重置）" } else { "" };
                push(&mut rows, 1, Some(r.remaining), format!("剩余 {}%{suffix}", fmt_pct(r.remaining)));
            }
            Some(_) => {}
        }
    }
    rows.sort_by(|(a, ra), (b, rb)| {
        a.tier
            .cmp(&b.tier)
            .then_with(|| b.remaining.unwrap_or(-1.0).total_cmp(&a.remaining.unwrap_or(-1.0)))
            .then_with(|| ra.cmp(rb))
            .then_with(|| a.name.cmp(&b.name))
    });
    rows.into_iter().map(|(c, _)| c).collect()
}

/// 百分比格式化：整数不带小数。
/// 参数：v——百分比；返回：文本。
fn fmt_pct(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// 读取与 JS 共用的测试用例。参数：无；返回：JSON 根对象。
    fn cases() -> Value {
        let text = include_str!("../../../docker/tests/fixtures/ranking-cases.json");
        serde_json::from_str(text).unwrap()
    }

    /// 从用例构造输入与设置。参数：v——用例；返回：(容器列表, now, 设置)。
    fn load(v: &Value) -> (Vec<QuotaInput>, i64, QuotaSettings) {
        let list: Vec<QuotaInput> = serde_json::from_value(v["containers"].clone()).unwrap();
        let st = &v["settings"];
        let s = QuotaSettings {
            warn_threshold: st["warn_threshold"].as_f64().unwrap(),
            critical_threshold: st["critical_threshold"].as_f64().unwrap(),
            switch_threshold: st["switch_threshold"].as_f64().unwrap(),
            allow_api_fallback: st["allow_api_fallback"].as_bool().unwrap(),
            include_stopped: st["include_stopped"].as_bool().unwrap(),
            ..QuotaSettings::default()
        };
        (list, v["now"].as_i64().unwrap(), s)
    }

    #[test]
    fn 健康度与共享用例一致() {
        let v = cases();
        let (list, now, s) = load(&v);
        for c in &list {
            let expect: Health = serde_json::from_value(v["expect"]["health"][&c.name].clone()).unwrap();
            assert_eq!(health_of(c, now, &s), expect, "health {}", c.name);
        }
    }

    #[test]
    fn 剩余额度与共享用例一致() {
        let v = cases();
        let (list, now, _) = load(&v);
        for (name, expect) in v["expect"]["remaining"].as_object().unwrap() {
            let c = list.iter().find(|c| &c.name == name).unwrap();
            let got = remaining_of(c.quota.as_ref(), now).map(|r| r.remaining);
            assert_eq!(got, expect.as_f64(), "remaining {name}");
        }
    }

    #[test]
    fn 候选排序与共享用例一致() {
        let v = cases();
        let (list, now, s) = load(&v);
        let names = |cs: Vec<Candidate>| cs.into_iter().map(|c| c.name).collect::<Vec<_>>();
        let expect: Vec<String> = serde_json::from_value(v["expect"]["rank_default"].clone()).unwrap();
        assert_eq!(names(rank_candidates(&list, "claude-dev-01", now, &s)), expect);

        let s2 = QuotaSettings { include_stopped: true, allow_api_fallback: true, ..s };
        let expect2: Vec<String> = serde_json::from_value(v["expect"]["rank_with_stopped_and_api"].clone()).unwrap();
        assert_eq!(names(rank_candidates(&list, "claude-dev-01", now, &s2)), expect2);
    }

    #[test]
    fn 恢复时间取耗尽窗口的重置时间() {
        let v = cases();
        let (list, now, _) = load(&v);
        assert_eq!(blocked_until(list[0].quota.as_ref(), now, 100.0), v["expect"]["blocked_until_01"].as_i64());
        assert_eq!(blocked_until(list[1].quota.as_ref(), now, 100.0), None);
    }

    #[test]
    fn 推荐理由文案() {
        let v = cases();
        let (list, now, s) = load(&v);
        let top = &rank_candidates(&list, "claude-dev-01", now, &s)[0];
        assert_eq!(top.reason, "剩余 80%（推断已重置）");
    }
}
