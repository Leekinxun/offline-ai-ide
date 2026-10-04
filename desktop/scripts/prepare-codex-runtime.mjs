import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCrownForgeCodexRuntime, fileSha256, runtimeBuildId, validateSourceLock, PATCHED_BINARIES } from "./build-crownforge-codex-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "scripts/fixtures/codex-native-runtime-lock.json"), "utf8"));
const digest = fileSha256;

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(executable)} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout || "";
}

function filesUnder(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Codex runtime contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) return filesUnder(absolute, relative);
    if (!entry.isFile()) throw new Error(`Unexpected Codex runtime entry: ${relative}`);
    return [relative];
  });
}

function verifyPE(file, arch) {
  const descriptor = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(descriptor, header, 0, 64, 0) !== 64 || header.toString("ascii", 0, 2) !== "MZ") throw new Error(`Invalid PE executable: ${file}`);
    const pe = Buffer.alloc(6);
    if (fs.readSync(descriptor, pe, 0, 6, header.readUInt32LE(0x3c)) !== 6 || pe.toString("ascii", 0, 4) !== "PE\0\0" || pe.readUInt16LE(4) !== (arch === "x64" ? 0x8664 : 0xaa64)) throw new Error(`Codex executable architecture mismatch: ${file}`);
  } finally { fs.closeSync(descriptor); }
}

function verifyRuntimeFiles(directory, receipt, arch) {
  if (!receipt.files || typeof receipt.files !== "object" || Array.isArray(receipt.files) || Object.keys(receipt.files).length > 10_000) throw new Error("Invalid Codex runtime inventory");
  const actualNames = filesUnder(directory).filter(name => name !== "crownforge-codex-runtime.json").sort();
  const expectedNames = Object.keys(receipt.files).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) throw new Error("Codex runtime contains unverified extra or missing files");
  for (const relative of lock.requiredFiles) if (!receipt.files[relative]) throw new Error(`Missing Codex runtime file: ${relative}`);
  for (const [relative, expected] of Object.entries(receipt.files)) {
    if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..") || relative.includes("\\") || relative.includes(":") || relative.includes("\0") || path.isAbsolute(relative) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid Codex runtime receipt path or hash");
    let file = directory;
    for (const component of relative.split("/")) {
      file = path.join(file, component);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Codex runtime inventory traverses a link");
    }
    if (!fs.statSync(file).isFile() || digest(file) !== expected) throw new Error(`Codex runtime checksum mismatch: ${relative}`);
    if (relative.endsWith(".exe")) verifyPE(file, arch);
  }
}

export function verifyCodexRuntime(directory, arch = "x64") {
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "crownforge-codex-runtime.json"), "utf8"));
  validateSourceLock(root, lock);
  if (receipt.schemaVersion !== 2 || receipt.runtimeVersion !== lock.runtimeVersion || receipt.upstreamVersion !== lock.runtimeVersion ||
      receipt.runtimeVariant !== lock.runtimeVariant || receipt.upstreamCommit !== lock.upstreamCommit || receipt.patchSha256 !== lock.patchSha256 ||
      receipt.buildId !== runtimeBuildId(lock) || receipt.baseArchiveSha256 !== lock.assets[arch]?.sha256 || receipt.platform !== "win32" || receipt.arch !== arch) throw new Error("CrownForge runtime receipt does not match the reviewed downstream build");
  verifyRuntimeFiles(directory, receipt, arch);
  for (const relative of Object.keys(PATCHED_BINARIES)) {
    if (receipt.patchedFiles?.[relative] !== receipt.files[relative]) throw new Error("CrownForge runtime has a missing or mixed patched binary");
  }
  return directory;
}

export function verifyOfficialCodexBaseline(directory, arch = "x64") {
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "crownforge-codex-runtime.json"), "utf8"));
  if (receipt.schemaVersion !== 1 || receipt.runtimeVersion !== lock.runtimeVersion || receipt.platform !== "win32" || receipt.arch !== arch || receipt.archiveSha256 !== lock.assets[arch].sha256) throw new Error("Official baseline receipt does not match the pinned archive");
  verifyRuntimeFiles(directory, receipt, arch);
  return directory;
}

function prepareOfficialBaseline(arch = "x64") {
  const asset = lock.assets[arch];
  if (!asset) throw new Error(`Unsupported Codex Windows architecture: ${arch}`);
  const cache = path.join(root, ".artifacts/codex-runtime-cache", lock.runtimeVersion, arch); fs.mkdirSync(cache, { recursive: true });
  const directory = path.join(cache, "baseline");
  if (fs.existsSync(path.join(directory, "crownforge-codex-runtime.json"))) return verifyOfficialCodexBaseline(directory, arch);
  const archive = path.join(cache, asset.name);
  const systemDirectory = process.env.SystemRoot && path.join(process.env.SystemRoot, "System32");
  const curl = process.platform === "win32" ? path.join(systemDirectory || "C:\\Windows\\System32", "curl.exe") : "curl";
  const tar = process.platform === "win32" ? path.join(systemDirectory || "C:\\Windows\\System32", "tar.exe") : "tar";
  if (!fs.existsSync(archive)) {
    const partial = `${archive}.partial`;
    run(curl, ["--fail", "--location", "--retry", "3", "--silent", "--show-error", "--output", partial, `https://github.com/openai/codex/releases/download/${lock.sourceTag}/${asset.name}`]);
    if (digest(partial) !== asset.sha256) { fs.rmSync(partial, { force: true }); throw new Error("Downloaded Codex archive checksum mismatch"); }
    fs.renameSync(partial, archive);
  }
  if (digest(archive) !== asset.sha256) throw new Error("Cached Codex archive checksum mismatch; remove the corrupt archive and retry");
  const entries = run(tar, ["-tzf", archive]).split(/\r?\n/).filter(Boolean);
  if (entries.some((entry) => entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes(".."))) throw new Error("Unsafe path in pinned Codex archive");
  const temporary = fs.mkdtempSync(path.join(cache, "extract-"));
  try {
    run(tar, ["-xzf", archive, "-C", temporary]);
    let extracted = temporary;
    if (!fs.existsSync(path.join(extracted, "bin/codex.exe"))) {
      const candidates = fs.readdirSync(temporary).map((name) => path.join(temporary, name)).filter((candidate) => fs.existsSync(path.join(candidate, "bin/codex.exe")));
      if (candidates.length !== 1) throw new Error("Pinned Codex package layout is unrecognized");
      extracted = candidates[0];
    }
    for (const name of ["LICENSE", "NOTICE"]) {
      if (!fs.existsSync(path.join(extracted, name))) run(curl, ["--fail", "--location", "--silent", "--show-error", "--output", path.join(extracted, name), `https://raw.githubusercontent.com/openai/codex/${lock.sourceTag}/${name}`]);
    }
    const files = Object.fromEntries(filesUnder(extracted).map((relative) => [relative, digest(path.join(extracted, ...relative.split("/")))]));
    fs.writeFileSync(path.join(extracted, "crownforge-codex-runtime.json"), JSON.stringify({ schemaVersion: 1, runtimeVersion: lock.runtimeVersion, platform: "win32", arch, sourceTag: lock.sourceTag, archiveSha256: asset.sha256, files }, null, 2));
    verifyOfficialCodexBaseline(extracted, arch);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.rmSync(directory, { recursive: true, force: true });
    fs.cpSync(extracted, directory, { recursive: true });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return verifyOfficialCodexBaseline(directory, arch);
}

export function prepareCodexRuntime(arch = "x64") {
  if (!lock.assets[arch]) throw new Error(`Unsupported Codex Windows architecture: ${arch}`);
  validateSourceLock(root, lock);
  const directory = path.join(root, "backend/vendor/codex", `win-${arch}`);
  if (fs.existsSync(path.join(directory, "crownforge-codex-runtime.json"))) return verifyCodexRuntime(directory, arch);
  const baseline = prepareOfficialBaseline(arch);
  buildCrownForgeCodexRuntime({ project: root, lock, arch, baseline, destination: directory, inventory: filesUnder, verifyPE });
  return verifyCodexRuntime(directory, arch);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Prepared CrownForge ${lock.runtimeVariant} (upstream Codex ${lock.runtimeVersion}): ${prepareCodexRuntime(process.argv[2] || "x64")}`);
}
