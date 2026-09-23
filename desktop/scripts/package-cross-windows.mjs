import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Cross-package Windows archives on macOS. Native node-pty cannot be built for
// Windows here, so omit it: the backend already falls back to cmd.exe pipes.
// These outputs still require installation checks on their target OS.
const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require("electron-builder");
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(desktopDir, "..");
const target = process.argv[2];
const skipBuild = process.argv.includes("--skip-build");
const targets = {
  "win-x64": { electron: "44.4.4", output: "win-x64-cross", artifact: "CrownForge-Windows-Cross-${version}-${arch}.${ext}" },
  "win7-x64": { electron: "22.3.27", output: "win7-x64-cross", artifact: "CrownForge-Win7-Cross-${version}-${arch}.${ext}" },
};
const selected = targets[target];
if (!selected || process.platform !== "darwin") {
  throw new Error("Use this cross-packager on macOS with win-x64 or win7-x64");
}
const stageDir = path.join(desktopDir, `.stage-cross-${target}`);
const backendStage = path.join(stageDir, "backend");
const outputDir = path.join(rootDir, "desktop-dist", selected.output);

function run(command, args, cwd, stdio = "inherit") {
  const result = spawnSync(command, args, { cwd, stdio });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  return result;
}

function npm(args, cwd) {
  if (!process.env.npm_execpath) throw new Error("Run through npm so npm_execpath is available");
  run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}

function verifyHash(file, expected) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected) throw new Error(`SHA-256 mismatch: ${file}\nexpected ${expected}\nactual   ${actual}`);
}

function verifyX64PE(file) {
  const handle = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(4096);
    const bytes = fs.readSync(handle, header, 0, header.length, 0);
    if (bytes < 64 || header.toString("ascii", 0, 2) !== "MZ") throw new Error(`Not a PE executable: ${file}`);
    const offset = header.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (fs.readSync(handle, pe, 0, pe.length, offset) !== pe.length || pe.toString("ascii", 0, 4) !== "PE\0\0" || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error(`Not a Windows x64 PE executable: ${file}`);
    }
  } finally {
    fs.closeSync(handle);
  }
}

if (!skipBuild) {
  npm(["run", "build"], path.join(rootDir, "backend"));
  npm(["run", "build"], path.join(rootDir, "frontend"));
}
for (const file of ["backend/dist/index.js", "frontend/dist/index.html"]) {
  if (!fs.existsSync(path.join(rootDir, file))) throw new Error(`Build output missing: ${file}`);
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(backendStage, { recursive: true });
for (const [source, destination] of [
  [path.join(rootDir, "backend", "dist"), path.join(backendStage, "dist")],
  [path.join(rootDir, "frontend", "dist"), path.join(stageDir, "frontend")],
  [path.join(rootDir, "plugins"), path.join(stageDir, "plugins")],
]) fs.cpSync(source, destination, { recursive: true });
for (const file of ["package.json", "package-lock.json", "bootstrap.cjs"]) {
  fs.copyFileSync(path.join(rootDir, "backend", file), path.join(backendStage, file));
}

// npm's os/cpu options select the Windows optional ripgrep package from the
// checked-in lockfile. Ignore postinstall scripts so node-pty cannot build a
// Darwin binary in the Windows staging area.
npm(["ci", "--omit=dev", "--ignore-scripts", "--os=win32", "--cpu=x64"], backendStage);
fs.rmSync(path.join(backendStage, "node_modules", "node-pty"), { recursive: true, force: true });

const rgBin = path.join(backendStage, "node_modules", "@vscode", "ripgrep-win32-x64", "bin", "rg.exe");
if (target === "win7-x64") {
  const archive = path.join(stageDir, "ripgrep-win7.zip");
  run("curl", ["--fail", "--location", "--silent", "--show-error", "--output", archive,
    "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10-x86_64-pc-windows-msvc.zip"], desktopDir);
  verifyHash(archive, "7b35b95cf3d7f92d8fe087006899617b1b5a6dac4bbed5d4f6ace6f0934799dc");
  fs.mkdirSync(path.dirname(rgBin), { recursive: true });
  run("unzip", ["-oq", archive, "rg.exe", "-d", path.dirname(rgBin)], desktopDir);
  verifyHash(rgBin, "5075519d24e22733aacdddd218c7023fc94c49150397e1eda5c4f6b866c3174e");
}
if (!fs.existsSync(path.join(backendStage, "node_modules", "@vscode", "ripgrep", "lib", "index.js"))) {
  throw new Error("Windows ripgrep wrapper is missing");
}
if (!fs.existsSync(rgBin)) throw new Error("Windows ripgrep binary is missing");
verifyX64PE(rgBin);

// Cross-host NSIS sometimes calls Wine to edit PE resources. Disabling that
// edit keeps the ZIP and NSIS builds native to macOS; the installer still uses
// icon.ico, while the application executable retains Electron's default icon.
const config = {
  appId: "com.crownforge.desktop",
  productName: "CrownForge",
  electronVersion: selected.electron,
  asar: true,
  npmRebuild: false,
  directories: { output: outputDir },
  files: ["main.cjs", "package.json"],
  extraResources: [
    { from: backendStage, to: "backend", filter: ["dist/**/*", "bootstrap.cjs", "package.json", "package-lock.json"] },
    { from: path.join(backendStage, "node_modules"), to: "backend/node_modules", filter: ["**/*"] },
    { from: path.join(stageDir, "frontend"), to: "frontend" },
    { from: path.join(stageDir, "plugins"), to: "plugins" },
  ],
  artifactName: selected.artifact,
  win: { executableName: "CrownForge", icon: path.join(desktopDir, "assets", "icon.ico"), signAndEditExecutable: false },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
};
await build({
  projectDir: desktopDir,
  targets: Platform.WINDOWS.createTarget(["nsis", "zip"], Arch.x64),
  config,
  publish: "never",
});

const resources = path.join(outputDir, "win-unpacked", "resources");
for (const relative of [
  "backend/bootstrap.cjs",
  "backend/dist/index.js",
  "backend/node_modules/undici/package.json",
  "backend/node_modules/@vscode/ripgrep/lib/index.js",
  "backend/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe",
  "frontend/index.html",
]) {
  if (!fs.existsSync(path.join(resources, relative))) throw new Error(`Packaged resource is missing: ${relative}`);
}
if (fs.existsSync(path.join(resources, "backend/node_modules/node-pty"))) throw new Error("Mac node-pty leaked into Windows package");
verifyX64PE(path.join(outputDir, "win-unpacked", "CrownForge.exe"));
verifyX64PE(path.join(resources, "backend/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe"));

const installers = fs.readdirSync(outputDir).filter((name) => name.endsWith(".exe") || name.endsWith(".zip"));
if (!installers.some((name) => name.endsWith(".exe")) || !installers.some((name) => name.endsWith(".zip"))) {
  throw new Error("Both NSIS installer and ZIP archive are required");
}
for (const name of installers) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(path.join(outputDir, name))) hash.update(chunk);
  fs.writeFileSync(path.join(outputDir, `${name}.sha256`), `${hash.digest("hex")}  ${name}\n`);
}
fs.writeFileSync(path.join(outputDir, "BUILD-NOTICE.txt"),
  `Cross-built on ${process.platform}-${process.arch} for ${target} with Electron ${selected.electron}.\n` +
  "Contains a Windows x64 ripgrep executable and uses the cmd.exe terminal fallback.\n" +
  "The installer has not been run or accepted on Windows; test on the target OS before release.\n");
