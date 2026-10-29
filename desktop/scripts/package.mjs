import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(desktopDir, "..");

export const DESKTOP_RUNTIME_FILES = Object.freeze([
  "main.cjs", "preload.cjs", "preferences.cjs", "bridge-policy.cjs",
  "connection.cjs", "connection-preload.cjs", "connection.html", "connection.css", "connection.js",
  "package.json",
]);

export const DESKTOP_TARGETS = Object.freeze({
  "mac-arm64": { host: "darwin", arch: "arm64", electron: "44.4.4", outputs: ["dmg", "zip"] },
  "mac-x64": { host: "darwin", arch: "x64", electron: "44.4.4", outputs: ["dmg", "zip"] },
  "win-x64": { host: "win32", arch: "x64", electron: "44.4.4", outputs: ["nsis", "zip"] },
  "win7-x64": { host: "win32", arch: "x64", electron: "22.3.27", outputs: ["nsis", "zip"] },
});

export function createPackageConfig(target, { cross = false } = {}) {
  const selected = DESKTOP_TARGETS[target];
  if (!selected) throw new Error(`Unknown target: ${target || "(missing)"}`);
  if (cross && selected.host !== "win32") throw new Error("Cross packaging supports Windows targets only");
  const artifactName = cross
    ? target === "win7-x64" ? "CrownForge-Win7-Cross-${version}-${arch}.${ext}" : "CrownForge-Windows-Cross-${version}-${arch}.${ext}"
    : target === "win7-x64" ? "CrownForge-Win7-${version}-${arch}.${ext}" : "CrownForge-${version}-${os}-${arch}.${ext}";
  return {
    appId: "com.crownforge.desktop",
    productName: "CrownForge",
    electronVersion: selected.electron,
    asar: true,
    npmRebuild: false,
    directories: { output: path.join(rootDir, "desktop-dist", `${target}${cross ? "-cross" : ""}`) },
    files: [...DESKTOP_RUNTIME_FILES],
    extraResources: [],
    artifactName,
    mac: { category: "public.app-category.developer-tools", icon: path.join(desktopDir, "assets", "icon.icns"), identity: null },
    win: { executableName: "CrownForge", icon: path.join(desktopDir, "assets", "icon.ico"), ...(cross ? { signAndEditExecutable: false } : {}) },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  };
}

export function verifyRemoteDesktopContents(archivePaths, packageJson) {
  const paths = new Set(archivePaths.map((entry) => entry.replaceAll("\\", "/").replace(/^\/+/, "")));
  for (const file of DESKTOP_RUNTIME_FILES) {
    if (!paths.has(file)) throw new Error(`Packaged client resource is missing: ${file}`);
  }
  for (const file of paths) {
    if (!DESKTOP_RUNTIME_FILES.includes(file)) throw new Error(`Unexpected resource in remote desktop package: ${file}`);
  }
  if (packageJson.main !== "main.cjs") throw new Error("The remote desktop package must launch main.cjs");
  if (Object.keys(packageJson.dependencies || {}).length) throw new Error("The remote desktop client must not bundle server runtime dependencies");
}

export function verifyRemoteDesktopPackage(resources) {
  const archive = path.join(resources, "app.asar");
  if (!fs.existsSync(archive)) throw new Error(`Packaged client archive is missing: ${archive}`);
  // electron-builder already depends on @electron/asar; no new runtime dependency is shipped.
  const asar = require("@electron/asar");
  verifyRemoteDesktopContents(asar.listPackage(archive), JSON.parse(asar.extractFile(archive, "package.json").toString("utf8")));
  for (const name of ["backend", "frontend", "plugins", "workspace", "users.json", "app-settings.json"]) {
    if (fs.existsSync(path.join(resources, name))) throw new Error(`Server data leaked into the remote desktop package: ${name}`);
  }
}

export async function writeChecksums(outputDir) {
  const artifacts = fs.readdirSync(outputDir).filter((name) => [".dmg", ".zip", ".exe"].includes(path.extname(name)));
  for (const name of artifacts) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(path.join(outputDir, name))) hash.update(chunk);
    fs.writeFileSync(path.join(outputDir, `${name}.sha256`), `${hash.digest("hex")}  ${name}\n`);
  }
  return artifacts;
}

export async function packageDesktop(target, { cross = false, unpacked = false } = {}) {
  const selected = DESKTOP_TARGETS[target];
  const config = createPackageConfig(target, { cross });
  if (selected.host === "darwin" && process.platform !== "darwin") throw new Error("macOS packages must be built on macOS");
  if (!cross && selected.host !== process.platform) throw new Error(`${target} must be built on ${selected.host}; use a cross-package command for Windows on macOS`);
  if (cross && process.platform !== "darwin") throw new Error("Use the Windows cross-packager on macOS");
  for (const file of DESKTOP_RUNTIME_FILES) {
    if (!fs.existsSync(path.join(desktopDir, file))) throw new Error(`Client source is missing: ${file}`);
  }
  const { build, Platform, Arch } = require("electron-builder");
  const platform = selected.host === "darwin" ? Platform.MAC : Platform.WINDOWS;
  const arch = selected.arch === "arm64" ? Arch.arm64 : Arch.x64;
  await build({
    projectDir: desktopDir,
    targets: platform.createTarget(unpacked ? ["dir"] : selected.outputs, arch),
    config,
    publish: "never",
  });
  const resources = selected.host === "darwin"
    ? path.join(config.directories.output, selected.arch === "x64" ? "mac" : "mac-arm64", "CrownForge.app", "Contents", "Resources")
    : path.join(config.directories.output, "win-unpacked", "resources");
  verifyRemoteDesktopPackage(resources);
  const artifacts = await writeChecksums(config.directories.output);
  if (!unpacked && (!artifacts.some((name) => name.endsWith(".zip")) || !artifacts.some((name) => name.endsWith(selected.host === "darwin" ? ".dmg" : ".exe")))) {
    throw new Error("Both an installer and a ZIP archive are required");
  }
  if (cross) {
    fs.writeFileSync(path.join(config.directories.output, "BUILD-NOTICE.txt"),
      `Cross-built on ${process.platform}-${process.arch} for ${target} with Electron ${selected.electron}.\n` +
      "Remote client only: frontend, backend, terminal tools, and projects stay on the configured server.\n" +
      "The installer has not been accepted on Windows; test on the target OS before release.\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await packageDesktop(process.argv[2], { unpacked: process.argv.includes("--dir") });
}
