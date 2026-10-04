// Build-time Git delivery only. Importing this module never downloads or installs tools.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lockPath = path.join(projectRoot, "scripts/fixtures/git-runtime-lock.json");
const manifestName = "crownforge-git-runtime.json";
const pinnedLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const lockDigest = crypto.createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex");
const builderDigest = crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");

export function fileSha256(file) {
  const hash = crypto.createHash("sha256"), descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally { fs.closeSync(descriptor); }
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

export function validateArchiveEntries(entries) {
  for (const entry of entries) {
    const value = entry.replace(/\/$/, "");
    if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)
        || value.split("/").some(segment => segment === ".." || !segment)) throw new Error("Unsafe Git archive path");
  }
}

// Relative symlinks are part of Git's relocatable install. Do not turn them into
// absolute links or copy each built-in alias as another full executable.
export function runtimeInventory(directory) {
  const root = fs.realpathSync.native(directory), files = {}, links = {};
  function visit(current, prefix = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === manifestName) continue;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (path.isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.includes("\\") || target.includes("\0")
            || !contained(root, path.resolve(path.dirname(file), target)) || !contained(root, fs.realpathSync.native(file))
            || !fs.statSync(file).isFile()) throw new Error(`Git runtime link escapes its bundle: ${relative}`);
        links[relative] = target;
      } else if (entry.isDirectory()) visit(file, relative);
      else if (entry.isFile()) files[relative] = fileSha256(file);
      else throw new Error(`Unexpected Git runtime entry: ${relative}`);
    }
  }
  visit(root);
  return { files, links };
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(executable)} failed: ${result.error?.message || result.stderr?.slice(-6000) || result.status}`);
  return result.stdout || "";
}

function cleanBuildEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|DYLD_|LD_|MAKEFLAGS$|MFLAGS$|CC$|CXX$|CFLAGS$|CPPFLAGS$|LDFLAGS$|LIBRARY_PATH$|CPATH$|C_INCLUDE_PATH$|PKG_CONFIG|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$|RUSTFLAGS$|RUSTDOCFLAGS$|RUSTC_WRAPPER$|RUSTC_WORKSPACE_WRAPPER$|CARGO_BUILD_TARGET$|CARGO_ENCODED_RUSTFLAGS$)/i.test(key)) delete env[key];
  env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  env.LANG = "en_US.UTF-8";
  env.MACOSX_DEPLOYMENT_TARGET = pinnedLock.macos.minimumVersion;
  return env;
}

async function verifiedArchive(asset, cache, suppliedArchive) {
  const archive = path.join(cache, asset.name);
  if (suppliedArchive) {
    const supplied = path.resolve(suppliedArchive);
    if (fs.lstatSync(supplied).isSymbolicLink() || !fs.statSync(supplied).isFile() || fileSha256(supplied) !== asset.sha256) throw new Error("Local Git source archive checksum mismatch");
    if (!fs.existsSync(archive)) fs.copyFileSync(supplied, archive);
  }
  if (fs.existsSync(archive)) {
    if (fs.lstatSync(archive).isSymbolicLink() || fileSha256(archive) !== asset.sha256) throw new Error("Cached Git archive checksum mismatch");
    return archive;
  }
  const partial = path.join(cache, `${asset.name}.${process.pid}.${crypto.randomUUID()}.partial`);
  try {
    console.log(`Downloading pinned Git resource ${asset.name}`);
    // Native curl also respects enterprise proxy configuration on build hosts;
    // --disable prevents a user curlrc from injecting other command options.
    run(systemTool("curl", process.platform), ["--disable", "--fail", "--location", "--silent", "--show-error",
      "--proto", "=https", "--connect-timeout", "30", "--max-time", "300", "--retry", "2", "--retry-max-time", "300",
      "--max-filesize", String(128 * 1024 * 1024), "--output", partial, asset.url], { timeout: 360_000 });
    if (fs.statSync(partial).size > 128 * 1024 * 1024) throw new Error("Git archive exceeds its size limit");
    if (fileSha256(partial) !== asset.sha256) throw new Error("Downloaded Git archive checksum mismatch");
    fs.renameSync(partial, archive);
  } finally { fs.rmSync(partial, { force: true }); }
  return archive;
}

function systemTool(name, platform) {
  if (platform === "darwin") return path.join("/usr/bin", name);
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root || !path.win32.isAbsolute(root)) throw new Error("Windows SystemRoot is unavailable");
  return path.win32.join(root, "System32", `${name}.exe`);
}

function extractArchive(archive, destination, platform) {
  const tar = systemTool("tar", platform);
  const entries = run(tar, ["-tf", archive]).split(/\r?\n/).filter(Boolean);
  validateArchiveEntries(entries);
  run(tar, ["-xf", archive, "-C", destination]);
}

function verifyPE(file, arch) {
  const descriptor = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64), pe = Buffer.alloc(6);
    if (fs.readSync(descriptor, header, 0, 64, 0) !== 64 || header.toString("ascii", 0, 2) !== "MZ"
        || fs.readSync(descriptor, pe, 0, 6, header.readUInt32LE(0x3c)) !== 6 || pe.toString("ascii", 0, 4) !== "PE\0\0"
        || pe.readUInt16LE(4) !== (arch === "arm64" ? 0xaa64 : 0x8664)) throw new Error("Bundled Git PE architecture mismatch");
  } finally { fs.closeSync(descriptor); }
}

function above(version, floor) {
  const left = version.split(".").map(Number), right = floor.split(".").map(Number);
  for (let index = 0; index < 3; index++) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  return false;
}

function inspectMacBinaries(directory, arch, inventory) {
  const inspected = [];
  for (const relative of Object.keys(inventory.files)) {
    const file = path.join(directory, ...relative.split("/"));
    const description = run("/usr/bin/file", ["-b", file]);
    if (!description.startsWith("Mach-O")) continue;
    if (run("/usr/bin/lipo", ["-archs", file]).trim() !== (arch === "arm64" ? "arm64" : "x86_64")) throw new Error(`Git Mach-O architecture mismatch: ${relative}`);
    const dependencies = run("/usr/bin/otool", ["-L", file]).split("\n").filter(line => /^\s+/.test(line)).map(line => line.trim().split(" ")[0]);
    if (dependencies.some(value => !value.startsWith("/usr/lib/") && !value.startsWith("/System/Library/"))) throw new Error(`Git links an unbundled non-system library: ${relative}`);
    const metadata = run("/usr/bin/otool", ["-l", file]);
    const floors = metadata.split(/Load command \d+/).flatMap(block => {
      const field = /\bcmd LC_BUILD_VERSION\b/.test(block) ? "minos" : /\bcmd LC_VERSION_MIN_MACOSX\b/.test(block) ? "version" : null;
      return field ? [block.match(new RegExp(`^\\s*${field}\\s+(\\d+(?:\\.\\d+)+)`, "m"))?.[1]].filter(Boolean) : [];
    });
    if (!floors.length || floors.some(value => above(value, pinnedLock.macos.minimumVersion))) throw new Error(`Git requires a newer macOS version: ${relative}`);
    inspected.push({ path: relative, dependencies, minimumVersion: floors[0] });
  }
  if (!inspected.some(entry => entry.path === "bin/git")) throw new Error("Bundled Git Mach-O is missing");
  return inspected;
}

function result(directory, manifest) {
  return { directory, executable: path.join(directory, ...manifest.executable.split("/")),
    executableRelative: manifest.executable, binDirectories: manifest.binDirectories.map(value => path.join(directory, ...value.split("/"))), manifest };
}

export function verifyGitRuntime(directory, platform = process.platform, arch = process.arch) {
  const manifestFile = path.join(directory, manifestName);
  if (fs.lstatSync(manifestFile).isSymbolicLink()) throw new Error("Git runtime manifest cannot be a symlink");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const expectedExecutable = platform === "win32" ? "cmd/git.exe" : "bin/git";
  const expectedAsset = platform === "win32" ? pinnedLock.windows[arch] : pinnedLock.source;
  if (!expectedAsset || !["darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)
      || manifest.schemaVersion !== 1 || manifest.gitVersion !== pinnedLock.gitVersion || manifest.platform !== platform || manifest.arch !== arch
      || manifest.lockSha256 !== lockDigest || manifest.builderSha256 !== builderDigest || manifest.archiveSha256 !== expectedAsset.sha256 || manifest.executable !== expectedExecutable
      || JSON.stringify(manifest.binDirectories) !== JSON.stringify([platform === "win32" ? "cmd" : "bin"])) throw new Error("Git runtime receipt does not match the pinned delivery");
  const actual = runtimeInventory(directory);
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files) || JSON.stringify(actual.links) !== JSON.stringify(manifest.links)) throw new Error("Git runtime contains changed, missing or extra files");
  for (const file of platform === "win32" ? ["LICENSE.txt", "SOURCE-NOTICE.txt", "cmd/git.exe", "usr/bin/sh.exe"] : ["COPYING", `source/${pinnedLock.source.name}`, "source/build-recipe/desktop/scripts/prepare-git-runtime.mjs", "source/build-recipe/scripts/fixtures/git-runtime-lock.json", "licenses/upstream/reftable/LICENSE", "licenses/upstream/sha1dc/LICENSE.txt", "bin/git", "libexec/git-core/git-remote-http"]) {
    if (!actual.files[file] && !actual.links[file]) throw new Error(`Required Git resource is missing: ${file}`);
  }
  if (platform === "win32") verifyPE(path.join(directory, "cmd/git.exe"), arch);
  else if ((fs.statSync(path.join(directory, "bin/git")).mode & 0o111) === 0) throw new Error("Bundled Git is not executable");
  return result(directory, manifest);
}

function buildMac(source, destination, arch, archive) {
  const env = cleanBuildEnvironment();
  const sdk = run("/usr/bin/xcrun", ["--show-sdk-path"], { env }).trim();
  const targetArch = arch === "arm64" ? "arm64" : "x86_64";
  const flags = `-O2 -arch ${targetArch} -mmacosx-version-min=${pinnedLock.macos.minimumVersion} -isysroot '${sdk.replaceAll("'", "'\\''")}'`;
  const options = [
    `prefix=${destination}`, "CC=/usr/bin/clang", `CFLAGS=${flags}`, `LDFLAGS=${flags}`,
    `CURL_CFLAGS=-isysroot '${sdk.replaceAll("'", "'\\''")}'`, "CURL_LDFLAGS=-lcurl", "CURL_CONFIG=/usr/bin/false",
    "RUNTIME_PREFIX=YesPlease", "INSTALL_SYMLINKS=YesPlease", "NO_HOMEBREW=YesPlease", "NO_FINK=YesPlease", "NO_DARWIN_PORTS=YesPlease",
    "NO_GETTEXT=YesPlease", "NO_TCLTK=YesPlease", "NO_PERL=YesPlease", "NO_PYTHON=YesPlease", "NO_BASH_COMPLETION=YesPlease",
    "SHELL_PATH=/bin/sh", "NO_RUST=YesPlease",
  ];
  console.log(`Building pinned Git ${pinnedLock.gitVersion} for macOS ${pinnedLock.macos.minimumVersion} ${arch}`);
  run("/usr/bin/make", [`-j${Math.min(os.availableParallelism?.() || os.cpus().length, 8)}`, ...options, "all"], { cwd: source, env });
  run("/usr/bin/make", [...options, "install"], { cwd: source, env });
  fs.copyFileSync(path.join(source, "COPYING"), path.join(destination, "COPYING"));
  function copyLicenses(current, relative = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) copyLicenses(path.join(current, entry.name), next);
      else if (entry.isFile() && /^(?:COPYING|LICEN[SC]E|NOTICE|COPYRIGHT)(?:\.[A-Za-z0-9_-]+)?$/i.test(entry.name)) {
        const output = path.join(destination, "licenses/upstream", ...next.split("/"));
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(current, entry.name), output);
      }
    }
  }
  copyLicenses(source);
  fs.mkdirSync(path.join(destination, "source/build-recipe/desktop/scripts"), { recursive: true });
  fs.mkdirSync(path.join(destination, "source/build-recipe/scripts/fixtures"), { recursive: true });
  fs.copyFileSync(archive, path.join(destination, "source", pinnedLock.source.name));
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(destination, "source/build-recipe/desktop/scripts/prepare-git-runtime.mjs"));
  fs.copyFileSync(lockPath, path.join(destination, "source/build-recipe/scripts/fixtures/git-runtime-lock.json"));
  fs.writeFileSync(path.join(destination, "SOURCE-NOTICE.txt"), `Git ${pinnedLock.gitVersion}; unmodified upstream source: source/${pinnedLock.source.name}\nOriginal URL: ${pinnedLock.source.url}\nSHA-256: ${pinnedLock.source.sha256}\nGPL license: COPYING; additional upstream licenses: licenses/upstream. Build options are recorded in crownforge-git-runtime.json.\nBuilt-in GUI, translations, Perl/Python adapters and completion scripts are excluded; local Git, HTTP(S) helpers and system SSH remain available. The supported NO_RUST build option selects upstream's C fallbacks and requires no Cargo dependency downloads.\nOffline rebuilding: copy source/build-recipe to a writable directory, then run its desktop/scripts/prepare-git-runtime.mjs with the App's bundled Node and --source-archive=<absolute path to the bundled source archive>. Apple Command Line Tools provide clang/make/SDK for rebuilding, not for normal App use. No download occurs with the supplied hash-matching source archive.\n`);
  return { sdk, options };
}

export async function prepareGitRuntime({ project = projectRoot, platform = process.platform, arch = process.arch, destination, sourceArchive } = {}) {
  if (platform !== process.platform || arch !== process.arch || !["darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error("Git delivery must be prepared on its matching macOS or Windows host");
  project = path.resolve(project);
  if (destination) destination = path.resolve(destination);
  if (sourceArchive && platform !== "darwin") throw new Error("The local source archive option applies only to the macOS source build");
  const cache = path.join(project, ".artifacts/git-runtime-cache", lockDigest.slice(0, 16), `${platform}-${arch}`);
  fs.mkdirSync(cache, { recursive: true });
  const ready = path.join(cache, `runtime-${builderDigest.slice(0, 16)}`);
  if (!fs.existsSync(ready)) {
    const asset = platform === "win32" ? pinnedLock.windows[arch] : pinnedLock.source;
    const archive = await verifiedArchive(asset, cache, sourceArchive);
    const temporary = fs.mkdtempSync(path.join(cache, "prepare-"));
    try {
      const extracted = path.join(temporary, "extracted"); fs.mkdirSync(extracted);
      extractArchive(archive, extracted, platform);
      const staging = platform === "win32" ? extracted : path.join(temporary, "runtime");
      let build;
      if (platform === "darwin") build = buildMac(path.join(extracted, `git-${pinnedLock.gitVersion}`), staging, arch, archive);
      else fs.writeFileSync(path.join(staging, "SOURCE-NOTICE.txt"), `Official unmodified MinGit ${pinnedLock.windowsRelease}; archive: ${asset.url}\nSHA-256: ${asset.sha256}\nAll upstream LICENSE.txt, third-party license/notice and documentation files are retained. LICENSE.txt contains GPLv2 terms; no package-specific written source offer was found in this pinned archive.\nGit source tag: https://github.com/git-for-windows/git/tree/${pinnedLock.windowsRelease}\nGit source archive: https://github.com/git-for-windows/git/archive/refs/tags/${pinnedLock.windowsRelease}.tar.gz\nPackaging recipes: https://github.com/git-for-windows/build-extra\nThird-party source-package repositories: https://repo.msys2.org/msys/sources/ and https://repo.msys2.org/mingw/sources/\nThese links do not constitute a redistributor's written offer or a complete matching source collection. The redistributor must supply matching corresponding sources or establish its applicable source-distribution arrangement before distributing GPL-covered binaries. This preparer does not download a multi-gigabyte Git for Windows SDK.\n`);
      const inventory = runtimeInventory(staging);
      const manifest = { schemaVersion: 1, gitVersion: pinnedLock.gitVersion, platform, arch,
        executable: platform === "win32" ? "cmd/git.exe" : "bin/git", binDirectories: [platform === "win32" ? "cmd" : "bin"],
        lockSha256: lockDigest, builderSha256: builderDigest, archiveSha256: asset.sha256, buildProfile: platform === "win32" ? "official-mingit" : pinnedLock.macos.buildProfile,
        ...(platform === "darwin" ? { buildOptions: pinnedLock.macos.buildOptions } : {}),
        sourceMaterial: platform === "darwin" ? { mode: "bundled-unmodified-source-and-build-recipe", archive: `source/${asset.name}`, sha256: asset.sha256 }
          : { mode: "upstream-license-files-and-source-links", completeMatchingSourcesBundled: false, packageSpecificUpstreamOfferFound: false },
        ...(build ? { build, macBinaries: inspectMacBinaries(staging, arch, inventory) } : {}), ...inventory };
      const version = run(path.join(staging, ...manifest.executable.split("/")), ["--version"]);
      if (version.trim() !== `git version ${pinnedLock.gitVersion}${platform === "win32" ? ".windows.1" : ""}`) throw new Error("Built Git version does not match the pinned source");
      fs.writeFileSync(path.join(staging, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
      verifyGitRuntime(staging, platform, arch);
      fs.renameSync(staging, ready);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  const prepared = verifyGitRuntime(ready, platform, arch);
  if (!destination || path.resolve(destination) === path.resolve(ready)) return prepared;
  if (fs.existsSync(destination)) throw new Error("Git staging destination must be absent; only its owning packager may replace it");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(ready, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
  return verifyGitRuntime(destination, platform, arch);
}

export function smokeGitRuntime(directory) {
  const prepared = verifyGitRuntime(directory);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-bundled-git-"));
  try {
    const relocated = path.join(fixture, "Git 搬迁 with spaces"), workspace = path.join(fixture, "workspace");
    fs.cpSync(directory, relocated, { recursive: true, dereference: false, verbatimSymlinks: true });
    const { executable } = verifyGitRuntime(relocated);
    fs.mkdirSync(workspace); const home = path.join(fixture, "home"); fs.mkdirSync(home);
    const env = { PATH: "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "missing-config"), GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "" };
    if (process.platform === "win32") for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
    const git = args => run(executable, ["--no-pager", ...args], { cwd: workspace, env, timeout: 15_000 });
    const execPath = git(["--exec-path"]).trim();
    if (!contained(fs.realpathSync.native(relocated), fs.realpathSync.native(execPath))) throw new Error("Relocated Git resolves helpers outside its bundle");
    git(["init", "-b", "main"]);
    fs.writeFileSync(path.join(workspace, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(workspace, "中文.txt"), "first\n");
    git(["add", "."]); git(["-c", "user.name=Offline Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "owned fixture"]);
    fs.writeFileSync(path.join(workspace, "中文.txt"), "second\n");
    if (!git(["status", "--porcelain=v2"]).includes(".txt")) throw new Error("Bundled Git status did not observe the edit");
    if (!git(["diff", "--no-ext-diff", "--no-textconv"]).includes("+second")) throw new Error("Bundled Git diff did not observe the edit");
    if (git(["log", "-1", "--format=%s"]).trim() !== "owned fixture") throw new Error("Bundled Git log failed");
    if (git(["check-ignore", "--no-index", "ignored.txt"]).trim() !== "ignored.txt") throw new Error("Bundled Git ignore matching failed");
    const worktree = path.join(fixture, "owned-worktree");
    git(["worktree", "add", "--detach", worktree, "HEAD"]); git(["worktree", "remove", worktree]);
    const https = path.join(execPath, process.platform === "win32" ? "git-remote-https.exe" : "git-remote-https");
    if (!fs.existsSync(https)) throw new Error("Bundled Git HTTPS helper is missing");
    return { platform: process.platform, arch: process.arch, gitVersion: prepared.manifest.gitVersion, systemGitOnPath: false,
      relocated: true, checks: ["version", "relocated exec-path", "init", "add/commit", "status", "diff", "log", "check-ignore", "worktree add/remove", "HTTPS helper present"],
      authenticatedRemoteVerified: false };
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const prepared = await prepareGitRuntime({ destination: value("--destination"), sourceArchive: value("--source-archive") });
  const smoke = process.argv.includes("--smoke") ? smokeGitRuntime(prepared.directory) : undefined;
  console.log(JSON.stringify({ directory: prepared.directory, executable: prepared.executable, executableRelative: prepared.executableRelative, ...(smoke ? { smoke } : {}) }, null, 2));
}
