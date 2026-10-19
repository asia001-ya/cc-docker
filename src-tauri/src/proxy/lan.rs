//! LAN exceptions are restricted to private IPv4 networks so they cannot bypass the public proxy.
use std::net::Ipv4Addr;
use std::sync::LazyLock;

use serde::Deserialize;

use crate::error::{AppError, AppResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    private_cidrs: Vec<String>,
    max_entries: usize,
}

static POLICY: LazyLock<Policy> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../docker/rootfs/opt/tdc/lan-policy.json")).expect("内置内网策略")
});

pub fn default_cidrs() -> Vec<String> {
    POLICY.private_cidrs.clone()
}

/// Keep every private range outside the TUN, including ranges that the guard must reject.
pub fn route_exclusions() -> Vec<String> {
    let mut cidrs = default_cidrs();
    cidrs.push("169.254.0.0/16".into());
    cidrs
}

fn parse(value: &str) -> Option<(u32, u8)> {
    let (ip, prefix) = match value.split_once('/') {
        Some((ip, prefix)) => {
            if prefix.is_empty() || prefix.len() > 2 || !prefix.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            if prefix.len() > 1 && prefix.starts_with('0') {
                return None;
            }
            (ip, prefix.parse::<u8>().ok()?)
        }
        None => (value, 32),
    };
    if prefix > 32 {
        return None;
    }
    let ip = u32::from(ip.parse::<Ipv4Addr>().ok()?);
    let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
    Some((ip & mask, prefix))
}

/// Canonicalize host bits and single IPs, deduplicate, and reject a CIDR that spans public space.
pub fn normalize_cidrs(values: &[String]) -> AppResult<Vec<String>> {
    if values.len() > POLICY.max_entries {
        return Err(AppError::Invalid(format!("内网直连最多配置 {} 个 IP 或网段", POLICY.max_entries)));
    }
    let mut normalized = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let (network, prefix) = parse(value.trim())
            .ok_or_else(|| AppError::Invalid(format!("第 {} 项需填写有效的 IPv4 地址或 CIDR 网段", index + 1)))?;
        let private = POLICY.private_cidrs.iter().any(|range| {
            let (base, bits) = parse(range).expect("内置私有网段");
            let mask = u32::MAX << (32 - u32::from(bits));
            prefix >= bits && network & mask == base
        });
        if !private {
            return Err(AppError::Invalid(format!(
                "第 {} 项只能位于 10/8、172.16/12 或 192.168/16 内；不允许放行公网地址",
                index + 1
            )));
        }
        let cidr = format!("{}/{prefix}", Ipv4Addr::from(network));
        if !normalized.contains(&cidr) {
            normalized.push(cidr);
        }
    }
    Ok(normalized)
}

pub fn validate(enabled: bool, values: &[String]) -> AppResult<Vec<String>> {
    // An inactive list is only a saved preference; it must not prevent turning direct access off.
    if !enabled {
        return Ok(normalize_cidrs(values).unwrap_or_else(|_| values.to_vec()));
    }
    let cidrs = normalize_cidrs(values)?;
    if cidrs.is_empty() {
        return Err(AppError::Invalid("允许内网直连时，请至少填写一个内网 IP 或网段".into()));
    }
    Ok(cidrs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_address_boundary_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../docker/tests/fixtures/lan-cidrs.json")).unwrap();
        for case in cases["valid"].as_array().unwrap() {
            let input: Vec<String> = serde_json::from_value(case["input"].clone()).unwrap();
            assert_eq!(serde_json::to_value(normalize_cidrs(&input).unwrap()).unwrap(), case["expected"]);
        }
        for case in cases["invalid"].as_array().unwrap() {
            let input: Vec<String> = serde_json::from_value(case.clone()).unwrap();
            assert!(normalize_cidrs(&input).is_err(), "{input:?}");
        }
        assert!(normalize_cidrs(&vec!["10.0.0.1".into(); POLICY.max_entries + 1]).is_err());
        assert!(validate(true, &[]).is_err());
        assert!(validate(false, &[]).is_ok());
        assert!(validate(false, &["0.0.0.0/0".into()]).is_ok());
    }
}
