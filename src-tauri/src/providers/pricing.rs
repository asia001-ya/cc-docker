//! One catalog is bundled into both the desktop executable and the settings UI.
//! Expand aliases and pricing tiers at launch, never while reading old usage.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::TokenPricing;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LongContextPricing {
    pub input_tokens_threshold: u64,
    pub pricing: TokenPricing,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPrice {
    id: String,
    aliases: Vec<String>,
    pricing: TokenPricing,
    long_context: Option<LongContextPricing>,
}

#[derive(Deserialize)]
struct Catalog {
    models: Vec<ModelPrice>,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/data/claude-pricing.json"))
            .expect("bundled Claude pricing catalog must be valid")
    })
}

/// Only missing model entries are filled. Explicit custom prices, including
/// zero, and the provider's fallback rate remain intact.
pub(super) fn fill_missing(prices: &mut HashMap<String, TokenPricing>) -> bool {
    let mut changed = false;
    for model in &catalog().models {
        if let std::collections::hash_map::Entry::Vacant(entry) = prices.entry(model.id.clone()) {
            entry.insert(model.pricing);
            changed = true;
        }
    }
    changed
}

/// The serialized snapshot is self-contained. An exact alias override wins
/// over its canonical rate; a custom fixed rate disables the official tier.
pub(super) fn snapshot_prices(
    prices: &HashMap<String, TokenPricing>,
) -> (HashMap<String, TokenPricing>, HashMap<String, LongContextPricing>) {
    let mut expanded = prices.clone();
    let mut tiers = HashMap::new();
    for model in &catalog().models {
        let Some(&canonical) = prices.get(&model.id) else { continue };
        for id in std::iter::once(&model.id).chain(&model.aliases) {
            let effective = *expanded.entry(id.clone()).or_insert(canonical);
            if effective == model.pricing {
                if let Some(tier) = model.long_context {
                    tiers.insert(id.clone(), tier);
                }
            }
        }
    }
    (expanded, tiers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn bundled_catalog_has_unique_ids_and_valid_prices() {
        let mut ids = HashSet::new();
        assert!(catalog().models.len() >= 20);
        for model in &catalog().models {
            assert!(model.id.starts_with("claude-"));
            model.pricing.validate().unwrap();
            for id in std::iter::once(&model.id).chain(&model.aliases) {
                assert!(!id.trim().is_empty());
                assert!(ids.insert(id), "duplicate model ID: {id}");
            }
            if let Some(tier) = model.long_context {
                assert!(tier.input_tokens_threshold > 0);
                tier.pricing.validate().unwrap();
            }
        }
    }

    #[test]
    fn fills_missing_models_without_replacing_custom_or_zero_prices() {
        let custom = TokenPricing { input: 2.0, output: 9.0, cache_read: 0.1, cache_write: 2.5 };
        let mut prices = HashMap::from([
            ("claude-opus-5-5".into(), custom),
            ("claude-sonnet-5-5".into(), TokenPricing::default()),
            ("relay-special".into(), custom),
        ]);
        assert!(fill_missing(&mut prices));
        assert_eq!(prices["claude-opus-5-5"], custom);
        assert_eq!(prices["claude-sonnet-5-5"], TokenPricing::default());
        assert_eq!(prices["relay-special"], custom);
        assert_eq!(prices["claude-haiku-5-5"].input, 0.1);
        assert!(!fill_missing(&mut prices));
    }

    #[test]
    fn aliases_follow_canonical_custom_price_but_exact_override_wins() {
        let model = catalog().models.iter().find(|model| !model.aliases.is_empty()).unwrap();
        let canonical = TokenPricing { input: 7.0, ..Default::default() };
        let mut prices = HashMap::from([(model.id.clone(), canonical)]);
        let (expanded, _) = snapshot_prices(&prices);
        assert_eq!(expanded[&model.aliases[0]], canonical);
        prices.insert(model.aliases[0].clone(), TokenPricing::default());
        let (expanded, _) = snapshot_prices(&prices);
        assert_eq!(expanded[&model.id], canonical);
        assert_eq!(expanded[&model.aliases[0]], TokenPricing::default());
    }

    #[test]
    fn tier_is_frozen_in_snapshot_and_does_not_override_custom_fixed_rate() {
        let mut prices = HashMap::new();
        fill_missing(&mut prices);
        let (_, original_tiers) = snapshot_prices(&prices);
        assert_eq!(original_tiers["claude-haiku-5-5"].input_tokens_threshold, 100_000);
        assert_eq!(original_tiers["claude-haiku-5-5"].pricing.output, 2.5);
        prices.insert("claude-haiku-5-5".into(), TokenPricing::default());
        let (_, updated_tiers) = snapshot_prices(&prices);
        assert!(!updated_tiers.contains_key("claude-haiku-5-5"));
        assert!(original_tiers.contains_key("claude-haiku-5-5"));
    }
}
