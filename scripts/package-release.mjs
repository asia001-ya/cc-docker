/** Package only the two public Windows build outputs for a GitHub Release. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function section(text, header) {
  return text.split(new RegExp(`^\\[${header}\\]\\s*$`, "m"))[1]?.split(/^\[/m)[0] ?? "";
}

function stringField(text, field) {
  return text.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?$`, "m"))?.[1];
}

async function optionalFile(file) {
  try { return await readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function releaseMetadata(root) {
  const [packageText, tauriText, cargoText, npmLockText, cargoLockText] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
    readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8"),
    optionalFile(path.join(root, "package-lock.json")),
    optionalFile(path.join(root, "src-tauri/Cargo.lock")),
  ]);
  const pkg = JSON.parse(packageText);
  const tauri = JSON.parse(tauriText);
  const cargoPackage = section(cargoText, "package");
  const cargoName = stringField(cargoPackage, "name");
  const versions = [
    ["package.json", pkg.version],
    ["src-tauri/tauri.conf.json", tauri.version],
    ["src-tauri/Cargo.toml", stringField(cargoPackage, "version")],
  ];
  if (npmLockText) {
    const lock = JSON.parse(npmLockText);
    versions.push(["package-lock.json", lock.version]);
    if (lock.packages?.[""]) versions.push(["package-lock.json packages[\"\"]", lock.packages[""].version]);
  }
  if (cargoLockText) {
    const entry = cargoLockText.split(/^\[\[package\]\]\s*$/m)
      .find((block) => stringField(block, "name") === cargoName);
    versions.push(["src-tauri/Cargo.lock", entry && stringField(entry, "version")]);
  }
  const version = pkg.version;
  if (typeof version !== "string" || !stableVersion.test(version)) {
    throw new Error("Release version must be a stable major.minor.patch version.");
  }
  for (const [file, candidate] of versions) {
    if (candidate !== version) throw new Error(`${file}: version must match package.json (${version}).`);
  }
  const binaryName = tauri.mainBinaryName ?? cargoName;
  if (typeof binaryName !== "string" || !/^[A-Za-z0-9_-]+$/.test(binaryName)) {
    throw new Error("The Windows main binary name is invalid.");
  }
  if (typeof tauri.productName !== "string" || !tauri.productName.trim()
    || /[<>:"/\\|?*\x00-\x1f]/.test(tauri.productName)) {
    throw new Error("The Windows product name is invalid.");
  }
  return { version, binaryName, productName: tauri.productName };
}

async function publicBinary(file) {
  let stat;
  try { stat = await lstat(file); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Missing build output: ${file}. Run npm run tauri build first.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2) throw new Error(`Invalid build output: ${file}.`);
  const bytes = await readFile(file);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`Build output is not a Windows executable: ${file}.`);
  return bytes;
}

export async function packageRelease({ root = process.cwd(), output } = {}) {
  root = path.resolve(root);
  const { version, binaryName, productName } = await releaseMetadata(root);
  const buildDir = path.join(root, "src-tauri/target/release");
  const destination = path.resolve(output ?? path.join(buildDir, "release-assets", `v${version}`));
  const artifacts = [
    { name: `cc-docker-${version}-windows-x64.exe`, source: path.join(buildDir, `${binaryName}.exe`) },
    { name: `cc-docker-${version}-windows-x64-setup.exe`, source: path.join(buildDir, "bundle/nsis", `${productName}_${version}_x64-setup.exe`) },
  ];
  // Validate all inputs before creating output; a partially built release is never packaged.
  const binaries = await Promise.all(artifacts.map(async (asset) => ({ ...asset, bytes: await publicBinary(asset.source) })));
  // The generated NSIS source, when present, catches an installer left over from an older build.
  const nsis = await optionalFile(path.join(buildDir, "nsis/x64/installer.nsi"));
  if (nsis && nsis.match(/^!define VERSION "([^"]+)"\s*$/m)?.[1] !== version) {
    throw new Error("The generated NSIS installer version is stale. Run npm run tauri build first.");
  }
  for (const asset of artifacts) {
    if (path.resolve(asset.source) === path.join(destination, asset.name)) {
      throw new Error("Release output must be separate from the original build outputs.");
    }
  }
  await mkdir(path.dirname(destination), { recursive: true });
  try { await mkdir(destination); } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Release output already exists: ${destination}. Choose a new --output directory.`);
    throw error;
  }
  const createdDestination = await realpath(destination);
  try {
    const assets = [];
    for (const asset of binaries) {
      const digest = createHash("sha256").update(asset.bytes).digest("hex");
      await writeFile(path.join(destination, asset.name), asset.bytes, { flag: "wx" });
      assets.push({ name: asset.name, sha256: digest, size: asset.bytes.length });
    }
    await writeFile(path.join(destination, "SHA256SUMS.txt"), assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(""), { flag: "wx" });
    return { version, output: destination, assets };
  } catch (error) {
    // Remove only the exact output directory this invocation created, never source build files.
    if (await realpath(destination) === createdDestination) await rm(destination, { recursive: true });
    throw error;
  }
}

export function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--output" && args[1].trim()) return { output: args[1] };
  throw new Error("Usage: node scripts/package-release.mjs [--output <new-directory>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await packageRelease(parseArguments(process.argv.slice(2)));
    console.log(`Release v${result.version} packaged: ${result.output}`);
    for (const asset of result.assets) console.log(`  ${asset.name} (${asset.size} bytes)`);
    console.log("  SHA256SUMS.txt");
  } catch (error) {
    console.error(`[package-release] ${error.message}`);
    process.exitCode = 1;
  }
}
