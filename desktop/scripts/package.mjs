import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require("electron-builder");
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(desktopDir, "..");
const stageDir = path.join(desktopDir, ".stage");
const target = process.argv[2];
const targets = {
  "mac-arm64": { host: "darwin", platform: Platform.MAC, arch: Arch.arm64, electron: "44.4.4", outputs: ["dmg", "zip"] },
  "mac-x64": { host: "darwin", platform: Platform.MAC, arch: Arch.x64, electron: "44.4.4", outputs: ["dmg", "zip"] },
  "win-x64": { host: "win32", platform: Platform.WINDOWS, arch: Arch.x64, electron: "44.4.4", outputs: ["nsis", "zip"] },
  "win7-x64": { host: "win32", platform: Platform.WINDOWS, arch: Arch.x64, electron: "22.3.27", outputs: ["nsis", "zip"] },
};
const selected = targets[target];
if (!selected) throw new Error(`Unknown target: ${target || "(missing)"}`);
if (process.platform !== selected.host) throw new Error(`${target} must be built on ${selected.host} to prepare native modules`);
const targetArch = target.endsWith("x64") ? "x64" : "arm64";
if (process.arch !== targetArch) throw new Error(`${target} must be built on a ${targetArch} host so ripgrep and node-pty match the package architecture`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

function npm(args, cwd) {
  if (!process.env.npm_execpath) throw new Error("Run this script through npm so npm_execpath is available");
  run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}

npm(["run", "build"], path.join(rootDir, "backend"));
npm(["run", "build"], path.join(rootDir, "frontend"));
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, "backend"), { recursive: true });
for (const [source, destination] of [
  [path.join(rootDir, "backend", "dist"), path.join(stageDir, "backend", "dist")],
  [path.join(rootDir, "frontend", "dist"), path.join(stageDir, "frontend")],
  [path.join(rootDir, "plugins"), path.join(stageDir, "plugins")],
]) fs.cpSync(source, destination, { recursive: true });
for (const file of ["package.json", "package-lock.json", "bootstrap.cjs"]) {
  fs.copyFileSync(path.join(rootDir, "backend", file), path.join(stageDir, "backend", file));
}
npm(["ci", "--omit=dev"], path.join(stageDir, "backend"));
if (target === "win7-x64") {
  // Current ripgrep binaries are built with a Rust toolchain whose default
  // Windows target requires Windows 10. This pre-2024 wrapper uses rg 13.
  // Fetch its exact upstream binary directly: the old postinstall uses the
  // GitHub API and can leave an empty bin directory after a damaged cache.
  npm(["install", "--omit=dev", "--save-exact", "--ignore-scripts", "@vscode/ripgrep@1.15.9"], path.join(stageDir, "backend"));
  const archive = path.join(stageDir, "ripgrep-win7.zip");
  run("curl.exe", ["--fail", "--location", "--silent", "--show-error", "--output", archive,
    "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10-x86_64-pc-windows-msvc.zip"], desktopDir);
  const archiveHash = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (archiveHash !== "7b35b95cf3d7f92d8fe087006899617b1b5a6dac4bbed5d4f6ace6f0934799dc") {
    throw new Error("Windows 7 ripgrep archive checksum mismatch");
  }
  const binDir = path.join(stageDir, "backend", "node_modules", "@vscode", "ripgrep", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  run("tar.exe", ["-xf", archive, "-C", binDir], desktopDir);
}
const ripgrepModuleUrl = pathToFileURL(path.join(stageDir, "backend", "node_modules", "@vscode", "ripgrep", "lib", "index.js")).href;
const ripgrepModule = await import(ripgrepModuleUrl);
const ripgrepPath = ripgrepModule.rgPath ?? ripgrepModule.default?.rgPath;
if (!ripgrepPath || !fs.existsSync(ripgrepPath)) throw new Error("Staged ripgrep executable is missing");
if (target === "win7-x64") {
  const binaryHash = crypto.createHash("sha256").update(fs.readFileSync(ripgrepPath)).digest("hex");
  if (binaryHash !== "5075519d24e22733aacdddd218c7023fc94c49150397e1eda5c4f6b866c3174e") {
    throw new Error("Windows 7 ripgrep binary checksum mismatch");
  }
}
const ripgrepProbe = spawnSync(ripgrepPath, ["--version"], { cwd: desktopDir, encoding: "utf8" });
if (ripgrepProbe.error || ripgrepProbe.status !== 0) throw new Error("Staged ripgrep executable cannot run on the build host");
if (target === "win7-x64" && !ripgrepProbe.stdout.startsWith("ripgrep 13.0.0")) {
  throw new Error("Windows 7 package requires the pinned ripgrep 13 binary");
}
process.stdout.write(ripgrepProbe.stdout);
const rebuild = path.join(desktopDir, "node_modules", "@electron", "rebuild", "lib", "cli.js");
run(process.execPath, [rebuild, "-f", "-v", selected.electron, "-m", path.join(stageDir, "backend"), "--arch", targetArch], desktopDir);

const config = {
  appId: "com.crownforge.desktop",
  productName: "CrownForge",
  electronVersion: selected.electron,
  asar: true,
  npmRebuild: false,
  directories: { output: path.join(rootDir, "desktop-dist", target) },
  files: ["main.cjs", "package.json"],
  extraResources: [
    { from: path.join(stageDir, "backend"), to: "backend", filter: ["dist/**/*", "bootstrap.cjs", "package.json", "package-lock.json"] },
    { from: path.join(stageDir, "backend", "node_modules"), to: "backend/node_modules", filter: ["**/*"] },
    { from: path.join(stageDir, "frontend"), to: "frontend" },
    { from: path.join(stageDir, "plugins"), to: "plugins" },
  ],
  artifactName: target === "win7-x64"
    ? "CrownForge-Win7-${version}-${arch}.${ext}"
    : "CrownForge-${version}-${os}-${arch}.${ext}",
  mac: { category: "public.app-category.developer-tools", icon: path.join(desktopDir, "assets", "icon.icns"), identity: null },
  win: { executableName: "CrownForge", icon: path.join(desktopDir, "assets", "icon.ico") },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
};
await build({
  projectDir: desktopDir,
  targets: selected.platform.createTarget(selected.outputs, selected.arch),
  config,
  publish: "never",
});

const packageResources = selected.host === "darwin"
  ? path.join(config.directories.output, targetArch === "x64" ? "mac" : "mac-arm64", "CrownForge.app", "Contents", "Resources")
  : path.join(config.directories.output, "win-unpacked", "resources");
for (const relative of [
  "backend/bootstrap.cjs",
  "backend/dist/index.js",
  "backend/node_modules/undici/package.json",
  "backend/node_modules/@vscode/ripgrep/package.json",
  "frontend/index.html",
]) {
  const item = path.join(packageResources, relative);
  if (!fs.existsSync(item)) throw new Error(`Packaged resource is missing: ${item}`);
}
for (const name of fs.readdirSync(config.directories.output)) {
  if (![".dmg", ".zip", ".exe"].includes(path.extname(name))) continue;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(config.directories.output, name))).digest("hex");
  fs.writeFileSync(path.join(config.directories.output, `${name}.sha256`), `${digest}  ${name}\n`);
}
