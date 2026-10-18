/** Build-time guard for public assets. Never reads installed user data or prints suspect values. */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class PrivacyCheckError extends Error {}

function reject(location, reason) {
  throw new PrivacyCheckError(`${location}: ${reason}`);
}

function objectFields(value, required, optional, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(location, "expected an object");
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) reject(location, "unapproved field in public data");
  if (required.some((key) => !Object.hasOwn(value, key))) reject(location, "required public field is missing");
}

function textField(value, location, maxLength = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) reject(location, "invalid public text");
  scanText(value, location);
}

function positiveInteger(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) reject(location, "expected a positive integer");
}

function officialUrl(value, location) {
  let url;
  try { url = new URL(value); } catch { reject(location, "invalid public source URL"); }
  // Only documentation/news origins: do not accept account, API, or arbitrary subdomains.
  const publicHosts = new Set(["claude.com", "www.claude.com", "platform.claude.com", "docs.claude.com", "anthropic.com", "www.anthropic.com", "docs.anthropic.com"]);
  if (typeof value !== "string" || url.protocol !== "https:" || !publicHosts.has(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || value.includes("?") || value.includes("#")) {
    reject(location, "source URL must be a public official HTTPS URL without credentials or parameters");
  }
  scanText(value, location);
}

function rateCard(value, location) {
  objectFields(value, ["input", "output", "cacheRead", "cacheWrite"], [], location);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) reject(`${location}.${key}`, "invalid public rate");
  }
}

/** Strictly validate every object in the only bundled pricing catalog. */
export function validatePricingCatalog(catalog, location = "src/data/claude-pricing.json") {
  objectFields(catalog, ["checkedAt", "sourceUrl", "modelIdsSourceUrl", "currency", "tokensPerUnit", "cacheWriteTtlMinutes", "models"], [], location);
  if (typeof catalog.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(catalog.checkedAt)) reject(location, "invalid catalog date");
  if (catalog.currency !== "USD") reject(location, "unsupported catalog currency");
  positiveInteger(catalog.tokensPerUnit, `${location}.tokensPerUnit`);
  positiveInteger(catalog.cacheWriteTtlMinutes, `${location}.cacheWriteTtlMinutes`);
  officialUrl(catalog.sourceUrl, `${location}.sourceUrl`);
  officialUrl(catalog.modelIdsSourceUrl, `${location}.modelIdsSourceUrl`);
  if (!Array.isArray(catalog.models) || !catalog.models.length) reject(location, "public model list is missing");
  const ids = new Set();
  catalog.models.forEach((model, index) => {
    const scope = `${location}.models[${index}]`;
    objectFields(model, ["id", "name", "aliases", "pricing"], ["longContext", "sourceUrl", "cacheSourceUrl", "note"], scope);
    textField(model.name, `${scope}.name`, 120);
    if (!Array.isArray(model.aliases)) reject(scope, "invalid model aliases");
    for (const id of [model.id, ...model.aliases]) {
      if (typeof id !== "string" || !/^claude-[a-z0-9-]+$/.test(id) || ids.has(id)) reject(scope, "invalid or duplicate public model ID");
      ids.add(id);
    }
    rateCard(model.pricing, `${scope}.pricing`);
    for (const key of ["sourceUrl", "cacheSourceUrl"]) if (Object.hasOwn(model, key)) officialUrl(model[key], `${scope}.${key}`);
    if (Object.hasOwn(model, "note")) textField(model.note, `${scope}.note`);
    if (Object.hasOwn(model, "longContext")) {
      objectFields(model.longContext, ["inputTokensThreshold", "pricing"], [], `${scope}.longContext`);
      positiveInteger(model.longContext.inputTokensThreshold, `${scope}.longContext.inputTokensThreshold`);
      rateCard(model.longContext.pricing, `${scope}.longContext.pricing`);
    }
  });
}

function emptyResources(value) {
  return value == null || (Array.isArray(value) && value.length === 0)
    || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

/** Resource changes require an explicit update of this public-only packaging policy. */
export function validateTauriConfig(config, location = "src-tauri/tauri.conf.json") {
  if (config?.build?.frontendDist !== "../dist") reject(location, "frontendDist must use the checked dist directory");
  if (!emptyResources(config?.bundle?.resources) || !emptyResources(config?.bundle?.externalBin)) reject(location, "additional bundle resources are not approved");
  const nsis = config?.bundle?.windows?.nsis;
  if (nsis?.installerHooks != null || nsis?.template != null) reject(location, "custom installer resource hooks are not approved");
}

const privateNames = /^(?:(?:providers?|proxies|proxy|sessions|accounts|auth-accounts|auth_accounts|credentials|tokens?|auth|settings|config|git-sharing)\.(?:json|ya?ml)|\.gitconfig|\.git-credentials|\.credentials\.json|\.claude\.json|(?:requests|history|usage)\.jsonl|usage\.(?:db|sqlite|sqlite3)|\.env(?:\..*)?)(?:\.(?:bak|backup|old|orig|save|tmp|temp)|~)*$/i;
const privateDirectories = new Set([".claude", ".codex", ".ssh", ".git"]);
// New public data files need an explicit review and validator before embedding.
const publicDataFiles = new Set(["src/data/claude-pricing.json"]);
const secretPatterns = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
  // Literal token assignments use compact ASCII credentials. Do not match translated UI explanations.
  /["'`]?(?:token|accessToken|refreshToken|apiKey|api_key|authToken|auth_token|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)["'`]?\s*[:=]\s*["'`][A-Za-z0-9_./+~=-]{16,}["'`]/i,
];
const demoMarkers = [
  "团队中转", "我的机场", "东京 VPS", "上海中转", "住宅 IP", "Anthropic API（示例）",
  "https://api.example.com", "https://sub.example.com", "tokyo.example.com", "relay.example.com",
  "203.0.113.9", "demo-anthropic", "demo-history-frontend", "demo-history-backend", "demo0001", "demo0002",
];

export function scanText(content, location, { production = false } = {}) {
  if (secretPatterns.some((pattern) => pattern.test(content))) reject(location, "possible hardcoded credential");
  if (production && (demoMarkers.some((marker) => content.includes(marker)) || /dev(?:\d+|\$\{[^}]+\})@example\.com/.test(content))) {
    reject(location, "development supplier, account, or proxy fixture found in production assets");
  }
}

async function statOptional(file, location) {
  try { return await lstat(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    reject(location, "cannot inspect build input");
  }
}

async function assertNoLinkedAncestors(root, relative) {
  let current = root;
  for (const segment of ["", ...relative.split("/")]) {
    current = path.join(current, segment);
    const stat = await statOptional(current, relative);
    if (!stat) return;
    if (stat.isSymbolicLink()) reject(relative, "symbolic links are not allowed in build inputs");
  }
}

async function readInput(file, location) {
  try { return await readFile(file); } catch { reject(location, "cannot read build input"); }
}

async function readJson(root, relative) {
  await assertNoLinkedAncestors(root, relative);
  const text = (await readInput(path.join(root, relative), relative)).toString("utf8");
  return parseJson(text, relative);
}

function parseJson(text, location) {
  try { return JSON.parse(text); } catch { reject(location, "invalid JSON build input"); }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Tauri config overrides merge objects recursively; arrays and scalar values replace.
function mergeConfig(base, override) {
  if (!isObject(override)) return override;
  const current = isObject(base) ? base : {};
  return Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(override)])].map((key) => [
    key, Object.hasOwn(override, key) ? mergeConfig(current[key], override[key]) : current[key],
  ]));
}

async function validateEffectiveTauriConfig(root, platform, tauriConfig) {
  let config = await readJson(root, "src-tauri/tauri.conf.json");
  validateTauriConfig(config);
  const platformFile = { win32: "windows", darwin: "macos", linux: "linux" }[platform];
  if (platformFile) {
    const relative = `src-tauri/tauri.${platformFile}.conf.json`;
    if (await statOptional(path.join(root, relative), relative)) {
      const override = await readJson(root, relative);
      if (!isObject(override)) reject(relative, "invalid Tauri config override");
      config = mergeConfig(config, override);
      validateTauriConfig(config, relative);
    }
  }
  // The CLI passes --config contents to build.rs via this JSON environment variable.
  if (tauriConfig) {
    const override = parseJson(tauriConfig, "TAURI_CONFIG");
    if (!isObject(override)) reject("TAURI_CONFIG", "invalid Tauri config override");
    validateTauriConfig(mergeConfig(config, override), "TAURI_CONFIG");
  }
}

async function scanTree(root, relative, { required = false, production = false } = {}) {
  await assertNoLinkedAncestors(root, relative);
  async function visit(location) {
    const absolute = path.join(root, location);
    const stat = await statOptional(absolute, location);
    if (!stat) {
      if (required) reject(location, "required build input is missing");
      return;
    }
    if (stat.isSymbolicLink()) reject(location, "symbolic links are not allowed in build inputs");
    if (relative === "src/data" && location !== relative && !publicDataFiles.has(location)) reject(location, "unapproved public data file");
    const name = path.basename(location).toLowerCase();
    if (privateNames.test(name) || privateDirectories.has(name)) reject(location, "private runtime configuration is not a public build input");
    if (stat.isDirectory()) {
      let names;
      try { names = await readdir(absolute); } catch { reject(location, "cannot inspect build input directory"); }
      for (const child of names.sort()) await visit(`${location}/${child}`);
    } else if (stat.isFile()) {
      // Binary fonts/images are public assets too; filename and symlink checks still apply.
      if (/\.(?:json|jsonl|[cm]?js|[jt]sx?|css|html?|svg|txt|md|sh|ya?ml|toml|conf|map)$/i.test(name) || !path.extname(name)) {
        scanText((await readInput(absolute, location)).toString("utf8"), location, { production });
      }
    } else {
      reject(location, "unsupported build input file type");
    }
  }
  await visit(relative);
}

export async function checkBundlePrivacy({ root = process.cwd(), dist = false, platform = process.platform, tauriConfig = process.env.TAURI_CONFIG } = {}) {
  root = path.resolve(root);
  validatePricingCatalog(await readJson(root, "src/data/claude-pricing.json"));
  await validateEffectiveTauriConfig(root, platform, tauriConfig);
  for (const relative of ["src/data", "public", "docker/rootfs"]) await scanTree(root, relative);
  if (dist) await scanTree(root, "dist", { required: true, production: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--dist")) reject("bundle-privacy", "unsupported check option");
    await checkBundlePrivacy({ dist: args.includes("--dist") });
    console.log(`[bundle-privacy] public ${args.includes("--dist") ? "inputs and production assets" : "inputs"} passed`);
  } catch (error) {
    console.error(`[bundle-privacy] ${error instanceof PrivacyCheckError ? error.message : "build privacy validation failed"}`);
    process.exitCode = 1;
  }
}
