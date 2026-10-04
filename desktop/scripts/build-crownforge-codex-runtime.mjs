import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TARGETS = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };
export const PATCHED_BINARIES = {
  "bin/codex.exe": "codex.exe",
  "codex-resources/codex-command-runner.exe": "codex-command-runner.exe",
  "codex-resources/codex-windows-sandbox-setup.exe": "codex-windows-sandbox-setup.exe",
};

export function fileSha256(file) {
  const hash = crypto.createHash("sha256"), descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024); let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

export function runtimeBuildId(lock) {
  return `${lock.runtimeVariant}:${lock.upstreamCommit}:${lock.patchSha256}`;
}

export function sourceCacheDirectory(project, lock, arch) {
  const identity = crypto.createHash("sha256").update(`${runtimeBuildId(lock)}:${arch}`).digest("hex").slice(0, 16);
  return path.join(project, ".artifacts/cf-src", identity);
}

export function validateSourceLock(project, lock) {
  if (lock.runtimeVariant !== "crownforge-network-v1" || lock.runtimeVersion !== "0.160.0" ||
      lock.sourceTag !== "rust-v0.160.0" || lock.upstreamCommit !== "a956835d020762cb2b570053af06f643a11c0ecc" ||
      lock.sourceRepository !== "https://github.com/openai/codex" || lock.buildProfile !== "release" ||
      !/^[a-f0-9]{64}$/.test(lock.patchSha256) || /^0+$/.test(lock.patchSha256) ||
      lock.patchFile !== "desktop/rust/windows-sandbox-patches/crownforge-network-v1.patch") {
    throw new Error("Invalid CrownForge sandbox source lock");
  }
  const patch = path.join(project, lock.patchFile);
  const stat = fs.lstatSync(patch);
  if (!stat.isFile() || stat.isSymbolicLink() || fileSha256(patch) !== lock.patchSha256) throw new Error("CrownForge sandbox patch checksum mismatch");
  return patch;
}

function run(executable, args, cwd, env = {}, timeout = 5 * 60_000) {
  const result = spawnSync(executable, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit", shell: false, timeout });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.error?.code || result.status})`);
}
function output(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", shell: false, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(executable)} could not verify the source checkout`);
  return result.stdout.trim();
}
function rejectLinks(directory) {
  const absolute = path.resolve(directory); let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Sandbox build paths must not traverse links"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/** Builds only in a Windows packaging/CI environment. No OS sandbox setup is
 * performed here. The official package remains the verified baseline. */
export function buildCrownForgeCodexRuntime({ project, lock, arch, baseline, destination, inventory, verifyPE }) {
  const patch = validateSourceLock(project, lock);
  if (process.platform !== "win32" || process.arch !== arch || !TARGETS[arch]) throw new Error("Build the patched sandbox on Windows with the matching native architecture");
  const cache = sourceCacheDirectory(project, lock, arch);
  rejectLinks(cache); fs.mkdirSync(cache, { recursive: true });
  const source = path.join(cache, "source"), sourceReceipt = path.join(cache, "source.json");
  if (!fs.existsSync(sourceReceipt)) {
    if (fs.existsSync(source)) throw new Error("An incomplete sandbox source checkout exists; remove only this owned build cache before retrying");
    fs.mkdirSync(source);
    run("git", ["init", "--quiet"], source);
    run("git", ["config", "core.longpaths", "true"], source);
    run("git", ["remote", "add", "origin", lock.sourceRepository], source);
    run("git", ["-c", "core.autocrlf=false", "fetch", "--depth", "1", "origin", lock.upstreamCommit], source);
    run("git", ["-c", "core.autocrlf=false", "checkout", "--detach", "FETCH_HEAD"], source);
    if (output("git", ["rev-parse", "HEAD"], source) !== lock.upstreamCommit) throw new Error("Sandbox source commit mismatch");
    run("git", ["apply", "--check", patch], source);
    run("git", ["apply", "--index", patch], source);
    fs.writeFileSync(sourceReceipt, JSON.stringify({ upstreamCommit: lock.upstreamCommit, patchSha256: lock.patchSha256 }));
  } else {
    const receipt = JSON.parse(fs.readFileSync(sourceReceipt, "utf8"));
    if (receipt.upstreamCommit !== lock.upstreamCommit || receipt.patchSha256 !== lock.patchSha256 ||
        output("git", ["rev-parse", "HEAD"], source) !== lock.upstreamCommit) throw new Error("Sandbox build cache source identity mismatch");
    // A cached checkout must still contain exactly the reviewed patch.
    const actualDiff = spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: source, encoding: "utf8", timeout: 30_000 });
    const expected = fs.readFileSync(patch, "utf8");
    if (actualDiff.status !== 0 || actualDiff.stdout.replaceAll("\r\n", "\n") !== expected.replaceAll("\r\n", "\n")) throw new Error("Sandbox build cache was modified outside its reviewed patch");
  }
  const untracked = output("git", ["ls-files", "--others", "--exclude-standard"], source);
  const ignored = output("git", ["ls-files", "--others", "--ignored", "--exclude-standard"], source);
  if (untracked || ignored) throw new Error("Sandbox source cache contains unreviewed files");
  const cargoRoot = path.join(source, "codex-rs"), target = path.join(cache, "target");
  run("cargo", ["+1.95.0", "build", "--locked", "--release", "--target", TARGETS[arch], "-p", "codex-cli", "--bin", "codex", "-p", "codex-windows-sandbox", "--bin", "codex-command-runner", "--bin", "codex-windows-sandbox-setup"], cargoRoot, {
    CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_LTO: "false", CARGO_PROFILE_RELEASE_DEBUG: "0", CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
  }, 120 * 60_000);
  if (process.env.CROWNFORGE_BUILD_WFP_TESTS === "1") {
    run("cargo", ["+1.95.0", "test", "--locked", "--release", "--target", TARGETS[arch], "-p", "codex-windows-sandbox", "--lib", "--no-run"], cargoRoot, {
      CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_LTO: "false", CARGO_PROFILE_RELEASE_DEBUG: "0", CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
    }, 10 * 60_000);
    const deps = path.join(target, TARGETS[arch], "release", "deps");
    const tests = fs.readdirSync(deps).filter(name => /^codex_windows_sandbox-[a-f0-9]+\.exe$/.test(name));
    if (tests.length !== 1) throw new Error("The WFP readback test executable is ambiguous or missing");
    const proof = path.join(project, ".artifacts/app-rust-sandbox/owner-readback-executable.json");
    fs.mkdirSync(path.dirname(proof), { recursive: true });
    fs.writeFileSync(proof, JSON.stringify({ buildId: runtimeBuildId(lock), executable: path.join(deps, tests[0]) }));
  }
  const binaries = path.join(target, TARGETS[arch], "release");
  const staging = fs.mkdtempSync(path.join(cache, "runtime-"));
  try {
    fs.cpSync(baseline, staging, { recursive: true });
    fs.rmSync(path.join(staging, "crownforge-codex-runtime.json"));
    const patchedFiles = {};
    for (const [relative, name] of Object.entries(PATCHED_BINARIES)) {
      const binary = path.join(binaries, name); verifyPE(binary, arch);
      const published = path.join(staging, ...relative.split("/"));
      fs.copyFileSync(binary, published); patchedFiles[relative] = fileSha256(published);
    }
    const files = Object.fromEntries(inventory(staging).map(relative => [relative, fileSha256(path.join(staging, ...relative.split("/")))]));
    const receipt = { schemaVersion: 2, runtimeVersion: lock.runtimeVersion, upstreamVersion: lock.runtimeVersion,
      upstreamCommit: lock.upstreamCommit, runtimeVariant: lock.runtimeVariant, patchSha256: lock.patchSha256,
      buildId: runtimeBuildId(lock), baseArchiveSha256: lock.assets[arch].sha256, platform: "win32", arch,
      buildProfile: "release", buildOptions: { lto: false, debug: 0, codegenUnits: 16 }, patchedFiles, files };
    fs.writeFileSync(path.join(staging, "crownforge-codex-runtime.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    rejectLinks(destination);
    if (fs.existsSync(destination)) throw new Error("Refuse to overwrite a potentially running sandbox runtime; remove only verified generated staging before rebuilding");
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(staging, destination);
  } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
  return destination;
}
