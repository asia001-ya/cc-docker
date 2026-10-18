use super::*;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tdc-pricing-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn profile(id: &str) -> ProviderProfile {
    serde_json::from_value(serde_json::json!({"id":id,"name":id})).unwrap()
}

#[test]
fn existing_providers_are_migrated_persistently_without_changing_bindings_or_custom_prices() {
    let dir = TestDirectory::new();
    let path = dir.0.join("providers.json");
    let original = serde_json::json!({
        "providers": [
            {"id":"first","name":"Relay A","baseUrl":"https://relay.example","extraEnv":{"CUSTOM":"value"}},
            {"id":"second","name":"Relay B","pricing":{"input":12},
                "modelPricing":{"claude-opus-5-5":{"input":0,"output":0},"private-model":{"input":7}}}
        ],
        "bindings":{"container-a":"first","container-b":"second"}
    });
    fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
    let store = ProviderStore::load(&dir.0).unwrap();
    let first = store.get("first").unwrap();
    assert_eq!(first.model_pricing["claude-opus-5-5"].input, 4.0);
    assert_eq!(first.extra_env["CUSTOM"], "value");
    assert_eq!(first.base_url, "https://relay.example");
    let second = store.get("second").unwrap();
    assert_eq!(second.model_pricing["claude-opus-5-5"], TokenPricing::default());
    assert_eq!(second.model_pricing["private-model"].input, 7.0);
    assert_eq!(second.pricing.input, 12.0);
    assert_eq!(store.binding_of("container-b").as_deref(), Some("second"));
    let persisted = fs::read(&path).unwrap();
    let reloaded = ProviderStore::load(&dir.0).unwrap();
    assert_eq!(reloaded.get("first").unwrap(), first);
    assert_eq!(reloaded.get("second").unwrap(), second);
    assert_eq!(fs::read(&path).unwrap(), persisted);
}

#[test]
fn clean_install_and_later_saves_fill_models_and_emit_self_contained_snapshots() {
    let dir = TestDirectory::new();
    let store = ProviderStore::load(&dir.0).unwrap();
    assert!(store.data.lock().providers.is_empty());
    let saved = store.save(profile("new"), None).unwrap();
    assert_eq!(saved.model_pricing["claude-opus-5-5"].cache_read, 0.2);
    let body = store.render_usage_settings(Some("new")).unwrap();
    let snapshot: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(snapshot["modelPricing"]["claude-sonnet-4-5"]["input"], 3.0);
    assert_eq!(snapshot["modelPricingTiers"]["claude-haiku-5-5"]["pricing"]["input"], 0.5);
    assert!(snapshot.get("extraEnv").is_none());
    let mut edited = saved;
    edited.model_pricing.clear();
    assert!(store.save(edited, None).unwrap().model_pricing.contains_key("claude-opus-5-5"));
    assert_eq!(snapshot["modelPricing"]["claude-opus-5-5"]["input"], 4.0);
    let authorization: serde_json::Value = serde_json::from_slice(&store.render_usage_settings(None).unwrap()).unwrap();
    assert_eq!(authorization["pricing"]["input"], 0.0);
    assert!(authorization["modelPricing"].as_object().unwrap().is_empty());
    assert!(authorization.get("modelPricingTiers").is_none());
}

#[test]
fn malformed_configuration_is_not_overwritten_by_migration() {
    let dir = TestDirectory::new();
    let path = dir.0.join("providers.json");
    fs::write(&path, "not valid json").unwrap();
    assert!(ProviderStore::load(&dir.0).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "not valid json");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(ProviderStore::load(&dir.0).is_err());
}
