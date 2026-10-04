import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareCodexRuntime, verifyCodexRuntime } from "./prepare-codex-runtime.mjs";
import { prepareGitRuntime, verifyGitRuntime } from "./prepare-git-runtime.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.resolve(desktop, "..");
const rust = path.join(desktop, "rust");
const resources = path.join(rust, "resources");
const mode = process.argv[2] || "prepare";
if (!["prepare", "dev", "build", "package"].includes(mode)) throw new Error(`Unknown Rust desktop action: ${mode}`);
if (!["darwin", "win32"].includes(process.platform)) throw new Error("Native desktop packaging currently supports macOS and Windows; Linux frame isolation has not been verified");

function run(executable, args, cwd = rust, extraEnv = {}) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status})`);
}

function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run through npm --prefix desktop/rust so the current Node runtime and npm CLI stay paired");
  run(nodeExecutable, [npmCli, ...args], cwd);
}

const requestedNode = process.env.CROWNFORGE_NODE_EXECUTABLE;
const nodeExecutable = requestedNode ? path.resolve(requestedNode) : process.execPath;
if (requestedNode && !path.isAbsolute(requestedNode)) throw new Error("CROWNFORGE_NODE_EXECUTABLE must be absolute");
const nodeProbe = spawnSync(nodeExecutable, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,lts:process.release.lts||null})"], { encoding: "utf8" });
if (nodeProbe.error || nodeProbe.status !== 0) throw new Error("Node runtime probe failed");
const identity = JSON.parse(nodeProbe.stdout);
const minimumNodeMajor = mode === "dev" ? 20 : 22;
if (Number(identity.version.split(".")[0]) < minimumNodeMajor || identity.platform !== process.platform || identity.arch !== process.arch) throw new Error(`Node runtime must be Node ${minimumNodeMajor}+ and match the packaging host platform and architecture; use a supported LTS release for production packages`);
if (mode !== "dev" && !identity.lts) throw new Error("Production packages require an LTS Node runtime; Current and unsupported odd release lines are not accepted");
const rustProbe = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (rustProbe.error || rustProbe.status !== 0) throw new Error("Rust compiler probe failed");
const rustHost = rustProbe.stdout.match(/^host: (.+)$/m)?.[1];
const rustArch = rustHost?.startsWith("aarch64-") ? "arm64" : rustHost?.startsWith("x86_64-") ? "x64" : null;
if (rustArch !== identity.arch) throw new Error("Rust host and standalone Node architecture must match; cross-packaging is not supported by this script");
if (process.platform === "darwin" && mode !== "dev") {
  const linkage = spawnSync("otool", ["-L", nodeExecutable], { encoding: "utf8" });
  if (linkage.error || linkage.status !== 0) throw new Error("Cannot inspect the packaged Node runtime linkage");
  const dependencies = linkage.stdout.split("\n").filter((line) => /^\s+/.test(line)).map((line) => line.trim().split(" ")[0]);
  if (dependencies.some((file) => !file.startsWith("/System/Library/") && !file.startsWith("/usr/lib/"))) {
    throw new Error("Use an official standalone Node runtime for packaging; this executable links to unbundled local libraries");
  }
  const metadata = spawnSync("otool", ["-l", nodeExecutable], { encoding: "utf8" });
  if (metadata.error || metadata.status !== 0) throw new Error("Cannot inspect the Node runtime's macOS deployment target");
  const packageFloor = JSON.parse(fs.readFileSync(path.join(rust, "src-tauri/tauri.conf.json"), "utf8")).bundle.macOS.minimumSystemVersion;
  const versionParts = (version) => version.split(".").map(Number);
  const above = (version, floor) => { const a = versionParts(version), b = versionParts(floor); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return false; };
  const runtimeFloors = metadata.stdout.split(/Load command \d+/).flatMap((block) => {
    const marker = /\bcmd LC_BUILD_VERSION\b/.test(block) ? "minos" : /\bcmd LC_VERSION_MIN_MACOSX\b/.test(block) ? "version" : null;
    if (!marker) return [];
    const version = block.match(new RegExp(`^\\s*${marker}\\s+(\\d+\\.\\d+(?:\\.\\d+)?)\\s*$`, "m"))?.[1];
    return version ? [version] : [];
  });
  if (runtimeFloors.some((floor) => above(floor, packageFloor))) {
    throw new Error(`The selected Node runtime requires a newer macOS version than the package's ${packageFloor} target; select a compatible supported LTS runtime`);
  }
}

npm(["run", "build"], path.join(project, "backend"));
npm(["run", "build"], path.join(project, "frontend"));
const cargoArgs = ["build", ...(mode === "package" ? ["-p", "crownforge-ide-core"] : ["--workspace"])];
if (mode !== "dev") cargoArgs.push("--release");
run("cargo", cargoArgs);
if (mode === "dev") {
  run(path.join(rust, "target/debug", process.platform === "win32" ? "crownforge-desktop.exe" : "crownforge-desktop"), [], rust, {
    CROWNFORGE_NODE_EXECUTABLE: nodeExecutable,
  });
  process.exit(0);
}

// Only generated resource staging is replaced. Existing Electron staging and
// source/private configuration are never copied or changed by this script.
fs.mkdirSync(resources, { recursive: true });
for (const entry of fs.readdirSync(resources)) {
  if (entry !== ".gitkeep") fs.rmSync(path.join(resources, entry), { recursive: true, force: true });
}
for (const [source, destination] of [
  ["backend/dist", "backend/dist"], ["frontend/dist", "frontend"], ["plugins", "plugins"],
]) {
  if (fs.existsSync(path.join(project, source))) fs.cpSync(path.join(project, source), path.join(resources, destination), { recursive: true });
}
fs.mkdirSync(path.join(resources, "backend"), { recursive: true });
for (const file of ["package.json", "package-lock.json", "bootstrap.cjs"]) fs.copyFileSync(path.join(project, "backend", file), path.join(resources, "backend", file));
fs.copyFileSync(path.join(rust, "runtime/bootstrap.cjs"), path.join(resources, "bootstrap.cjs"));
fs.mkdirSync(path.join(resources, "node"), { recursive: true });
const runtimeDestination = path.join(resources, "node", process.platform === "win32" ? "node.exe" : "node");
fs.copyFileSync(nodeExecutable, runtimeDestination);
if (process.platform !== "win32") fs.chmodSync(runtimeDestination, 0o755);
const nodeLicense = [path.dirname(nodeExecutable), path.resolve(path.dirname(nodeExecutable), "..")]
  .map((directory) => path.join(directory, "LICENSE")).find((file) => fs.existsSync(file));
if (nodeLicense) fs.copyFileSync(nodeLicense, path.join(resources, "node/LICENSE"));
if (process.platform === "darwin") {
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  const architectures = spawnSync("lipo", ["-archs", runtimeDestination], { encoding: "utf8" });
  if (architectures.error || architectures.status !== 0) throw new Error("Cannot inspect the copied Node runtime architecture");
  if (architectures.stdout.trim().split(/\s+/).length > 1) {
    run("lipo", [nodeExecutable, "-thin", architecture, "-output", runtimeDestination]);
    fs.chmodSync(runtimeDestination, 0o755);
  }
}
fs.mkdirSync(path.join(resources, "binaries"), { recursive: true });
const coreName = process.platform === "win32" ? "crownforge-ide-core.exe" : "crownforge-ide-core";
fs.copyFileSync(path.join(rust, "target/release", coreName), path.join(resources, "binaries", coreName));
if (process.platform !== "win32") fs.chmodSync(path.join(resources, "binaries", coreName), 0o755);

const gitRuntime = await prepareGitRuntime();
fs.cpSync(gitRuntime.directory, path.join(resources, "git"), { recursive: true, dereference: false, verbatimSymlinks: true });
const bundledGit = verifyGitRuntime(path.join(resources, "git"));

if (process.platform === "win32") prepareCodexRuntime(process.arch);
const vendor = path.join(project, "backend/vendor");
if (fs.existsSync(vendor)) fs.cpSync(vendor, path.join(resources, "backend/vendor"), {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(vendor, source).split(path.sep);
    if (relative[0] !== "codex") return true;
    return process.platform === "win32" && (!relative[1] || relative[1] === `win-${process.arch}`);
  },
});
if (process.platform === "win32") verifyCodexRuntime(path.join(resources, "backend/vendor/codex", `win-${process.arch}`), process.arch);
// Desktop PTY runs in Rust. Install the retained JS services without compiling
// an unused Node PTY binding, then omit it only from this generated bundle.
// The Web backend's source manifests and installed dependencies stay intact.
npm(["ci", "--omit=dev", "--ignore-scripts"], path.join(resources, "backend"));
fs.rmSync(path.join(resources, "backend/node_modules/node-pty"), { recursive: true, force: true });
// TypeScript navigation and retained repository indexing still use the native
// ripgrep package; its current optional platform package ships the executable.
run(nodeExecutable, ["--input-type=module", "-e", "import { rgPath } from '@vscode/ripgrep'; import { spawnSync } from 'node:child_process'; const probe = spawnSync(rgPath, ['--version'], {stdio:'inherit'}); if (probe.error || probe.status !== 0) process.exit(1);"], path.join(resources, "backend"));
fs.writeFileSync(path.join(resources, "runtime-manifest.json"), `${JSON.stringify({
  schemaVersion: 1, platform: process.platform, arch: process.arch, nodeVersion: identity.version,
  nodeSha256: crypto.createHash("sha256").update(fs.readFileSync(runtimeDestination)).digest("hex"),
  ideCoreSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(resources, "binaries", coreName))).digest("hex"),
  gitVersion: bundledGit.manifest.gitVersion, gitExecutable: `git/${bundledGit.executableRelative}`,
  gitSha256: bundledGit.manifest.files[bundledGit.executableRelative],
}, null, 2)}\n`);
console.log(`Prepared Rust desktop resources: ${resources}`);

if (mode === "package") {
  const cli = path.join(rust, "node_modules/@tauri-apps/cli/tauri.js");
  if (!fs.existsSync(cli)) throw new Error("Run npm --prefix desktop/rust ci before packaging");
  const args = [cli, "build", ...process.argv.slice(3)];
  if (process.platform === "darwin") {
    // Generic resource copying expands Git's executable aliases. macOS custom
    // files preserve their relative symlinks and run before signing/notarization.
    const macOS = { files: { "Resources/runtime": resources } };
    const customConfiguration = process.argv.slice(3).some((argument) => argument === "--config" || argument === "-c" || argument.startsWith("--config="));
    if (!args.includes("--no-sign") && !customConfiguration && !process.env.APPLE_CERTIFICATE && !process.env.APPLE_SIGNING_IDENTITY) {
      // Seal ordinary local bundles before DMG creation. Tauri signs the host
      // and outer app; runtime binaries keep their verified source hashes.
      // An explicit signing configuration always controls distribution builds.
      macOS.signingIdentity = "-";
    }
    args.push("--config", JSON.stringify({ bundle: { resources: [], macOS } }));
  }
  run(process.execPath, args, rust);
  if (process.platform === "darwin") {
    const packaged = path.join(rust, "target/release/bundle/macos/CrownForge.app/Contents/Resources/runtime");
    const info = verifyGitRuntime(path.join(packaged, "git"));
    if (info.manifest.gitVersion !== bundledGit.manifest.gitVersion) throw new Error("Packaged Git runtime identity changed");
    for (const [relative, expected] of [["node/node", "nodeSha256"], ["binaries/crownforge-ide-core", "ideCoreSha256"]]) {
      const receipt = JSON.parse(fs.readFileSync(path.join(packaged, "runtime-manifest.json"), "utf8"));
      const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(packaged, relative))).digest("hex");
      if (actual !== receipt[expected]) throw new Error(`Packaged runtime identity changed: ${relative}`);
    }
    if (!args.includes("--no-sign")) run("/usr/bin/codesign", ["--verify", "--deep", "--strict", path.dirname(path.dirname(path.dirname(packaged)))]);
  }
}
