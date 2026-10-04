import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileSha256 } from "./build-crownforge-codex-runtime.mjs";

export const SDK_PRODUCER = Object.freeze({
  repository: "Leekinxun/offline-ai-ide",
  workflowPath: ".github/workflows/app-rust-sandbox.yml",
  branch: "APP_RUST",
  runId: 37188790813,
  sourceCommit: "74a2452bcb72b63a0d92f16b87ebace7f7e21c7f",
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function validateSdkProducer(run, artifact, checkoutLock, producerLock) {
  assert.equal(run.id, SDK_PRODUCER.runId, "SDK producer run mismatch");
  assert.equal(run.repository?.full_name, SDK_PRODUCER.repository, "SDK producer repository mismatch");
  assert.equal(run.head_repository?.full_name, SDK_PRODUCER.repository, "Fork SDK artifacts are not accepted");
  assert.equal(run.path, SDK_PRODUCER.workflowPath, "SDK producer workflow mismatch");
  assert.equal(run.head_branch, SDK_PRODUCER.branch, "SDK producer branch mismatch");
  assert.equal(run.head_sha, SDK_PRODUCER.sourceCommit, "SDK producer source commit mismatch");
  assert.equal(run.status, "completed", "SDK producer must finish before packaging");
  assert.equal(run.conclusion, "success", "SDK producer acceptance must pass before packaging");
  assert.equal(artifact.name, `crownforge-codex-runtime-${SDK_PRODUCER.runId}`, "SDK artifact name mismatch");
  assert.equal(artifact.expired, false, "SDK artifact expired");
  assert.equal(artifact.workflow_run?.id, SDK_PRODUCER.runId, "SDK artifact belongs to another run");
  assert.equal(artifact.workflow_run?.head_sha, SDK_PRODUCER.sourceCommit, "SDK artifact source mismatch");
  assert.match(artifact.digest || "", /^sha256:[a-f0-9]{64}$/, "SDK artifact SHA-256 evidence is required");
  assert.equal(JSON.stringify(canonical(checkoutLock)), JSON.stringify(canonical(producerLock)), "Package checkout and accepted SDK source locks differ");
  return { producer: SDK_PRODUCER, artifactId: artifact.id, artifactDigest: artifact.digest, runUrl: run.html_url };
}

export function nsisDefinitions(text) {
  const result = {};
  const wanted = new Set(["INSTALLWEBVIEW2MODE", "ARCH", "WEBVIEW2INSTALLERPATH", "MAINBINARYNAME", "MAINBINARYSRCPATH", "INSTALLMODE", "VERSION"]);
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.match(/^!define\s+([A-Z0-9_]+)\s+"(.*)"\s*$/);
    if (!match || !wanted.has(match[1])) continue;
    assert.ok(!(match[1] in result), `Duplicate NSIS definition: ${match[1]}`);
    result[match[1]] = match[2].replace(/\$\\"/g, '"').replace(/\$\$/g, "$");
  }
  assert.equal(result.INSTALLWEBVIEW2MODE, "offlineInstaller", "NSIS must embed the complete offline WebView2 installer");
  assert.equal(result.ARCH, "x64", "This acceptance lane verifies Windows x64 only");
  if (result.MAINBINARYNAME !== undefined) assert.match(result.MAINBINARYNAME, /^[A-Za-z0-9_-]+$/, "NSIS main binary name must be a package-local executable");
  assert.ok(result.WEBVIEW2INSTALLERPATH && path.win32.isAbsolute(result.WEBVIEW2INSTALLERPATH), "NSIS offline installer input is missing");
  assert.match(text, /File\s+"\/oname=\$TEMP\\MicrosoftEdgeWebView2RuntimeInstaller\.exe"\s+"\$\{WEBVIEW2INSTALLERPATH\}"/, "NSIS does not embed the expected standalone installer payload");
  return result;
}

export function peMachine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    assert.equal(fs.readSync(fd, header, 0, 64, 0), 64, "PE DOS header is truncated");
    assert.equal(header.toString("ascii", 0, 2), "MZ", "PE DOS signature mismatch");
    const offset = header.readUInt32LE(0x3c);
    assert.ok(offset >= 64 && offset <= fs.fstatSync(fd).size - 6, "PE header offset escapes the file");
    const pe = Buffer.alloc(6);
    assert.equal(fs.readSync(fd, pe, 0, pe.length, offset), pe.length, "PE header is truncated");
    assert.equal(pe.toString("ascii", 0, 4), "PE\0\0", "PE signature mismatch");
    return pe.readUInt16LE(4);
  } finally { fs.closeSync(fd); }
}

export function assertInstalledHostPayload({ extractedFiles, extractRoot, mainBinaryName, installedHost, originalBuildInput }) {
  assert.match(mainBinaryName || "", /^[A-Za-z0-9_-]+$/, "NSIS main executable name is required");
  const expectedName = `${mainBinaryName}.exe`.toLowerCase();
  const candidates = extractedFiles.filter((file) => path.basename(file).toLowerCase() === expectedName);
  assert.equal(candidates.length, 1, "Final NSIS must contain exactly one Host executable payload");
  const payload = candidates[0];
  assert.ok(fs.lstatSync(payload).isFile() && !fs.lstatSync(payload).isSymbolicLink(), "Host payload must be a regular extracted file");
  const relative = path.relative(fs.realpathSync.native(extractRoot), fs.realpathSync.native(payload));
  assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "Host payload must stay inside the owned NSIS extraction");
  for (const file of [payload, installedHost, originalBuildInput]) {
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), "NSIS Host evidence must be a regular file");
    assert.equal(peMachine(file), 0x8664, "NSIS Host evidence must be Windows x64 PE");
  }
  const embeddedPayloadSha256 = fileSha256(payload), installedSha256 = fileSha256(installedHost);
  assert.equal(installedSha256, embeddedPayloadSha256, "Installed Host differs from its exact final NSIS payload");
  // Tauri patches the main executable for each bundle, then restores the
  // unsigned/unpatched target/release input. They are separate evidence fields.
  return { mainBinaryName, embeddedPayloadPath: relative.replaceAll("\\", "/"), originalBuildInputSha256: fileSha256(originalBuildInput), embeddedPayloadSha256, installedSha256 };
}

export function filesUnder(directory) {
  const result = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      assert.ok(!entry.isSymbolicLink(), "Package inspection cannot follow a symbolic link");
      if (entry.isDirectory()) visit(file);
      else { assert.ok(entry.isFile(), "Package contains a non-regular resource"); result.push(file); }
      assert.ok(result.length <= 100_000, "Package file inventory exceeds its bound");
    }
  }
  visit(directory);
  return result;
}

export function dumpbinDependencies(output) {
  const names = [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[A-Za-z0-9_.+-]+\.dll$/i.test(line)))];
  assert.ok(names.length, "dumpbin did not return PE dependency evidence");
  return names;
}

const SYSTEM_DLLS = new Set(("advapi32 bcrypt bcryptprimitives cabinet cfgmgr32 comctl32 combase crypt32 cryptbase d3d11 d3d12 dbgcore dbghelp dhcpcsvc dnsapi dwmapi dxgi fwpuclnt gdi32 imm32 iphlpapi kernel32 kernelbase mpr msasn1 mmdevapi msimg32 msvcrt mswsock netapi32 ncrypt normaliz ntdll ole32 oleacc oleaut32 opengl32 propsys psapi rpcrt4 samcli secur32 setupapi shell32 shfolder shlwapi shcore sspicli tdh ucrtbase user32 userenv uxtheme version win32u winhttp wininet winmm winspool wintrust winusb wldap32 wldp ws2_32 wtsapi32 windowscodecs").split(" ").map((name) => `${name}.dll`));

export function classifyDependency(name, packagedDllNames) {
  const normalized = name.toLowerCase();
  assert.match(normalized, /^[a-z0-9_.+-]+\.dll$/, "Invalid imported DLL name");
  if (packagedDllNames.has(normalized)) return "packaged";
  if (/^(?:vcruntime|msvcp|concrt)\d/.test(normalized)) throw new Error(`Unbundled Visual C++ runtime dependency: ${name}`);
  if (SYSTEM_DLLS.has(normalized) || /^(?:api|ext)-ms-win-/.test(normalized)) return "windows-os";
  throw new Error(`Imported DLL has no explicit Windows OS or packaged resolution: ${name}`);
}

export function minGitDllDirectories(binary, gitRoot) {
  const relative = path.relative(gitRoot, binary).replaceAll("\\", "/").toLowerCase();
  assert.ok(relative && !relative.startsWith("../") && !path.isAbsolute(relative), "MinGit PE inspection must stay in its verified runtime");
  const adjacent = path.dirname(binary);
  if (relative.startsWith("cmd/") || relative.startsWith("ucrt64/bin/") || relative.startsWith("usr/bin/")) return [adjacent];
  throw new Error("No verified MinGit loader path is defined for this executable");
}

export function minGitSmokeExecutables(gitRuntime) {
  // Pinned MinGit puts its transport launcher beside the ucrt64 core. Its
  // libexec/git-core directory contains scripts, not the HTTP executable.
  const paths = { gitCore: "ucrt64/bin/git.exe", gitShell: "usr/bin/sh.exe", gitHttp: "ucrt64/bin/git-remote-http.exe" };
  return Object.fromEntries(Object.entries(paths).map(([key, relative]) => {
    const file = path.join(gitRuntime.directory, ...relative.split("/"));
    assert.ok(fs.lstatSync(file).isFile(), `Pinned MinGit executable is missing: ${relative}`);
    const expected = gitRuntime.manifest.files[relative];
    assert.match(expected || "", /^[a-f0-9]{64}$/, `Pinned MinGit executable is absent from its verified receipt: ${relative}`);
    assert.equal(fileSha256(file), expected, `Pinned MinGit executable differs from its verified receipt: ${relative}`);
    assert.equal(peMachine(file), 0x8664, `Pinned MinGit executable must be Windows x64 PE: ${relative}`);
    return [key, file];
  }));
}

export function assertRuntimeManifest(runtime) {
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "runtime-manifest.json"), "utf8"));
  assert.equal(manifest.platform, "win32");
  assert.equal(manifest.arch, "x64");
  assert.match(manifest.nodeVersion, /^22\./, "This package lane requires Node 22 LTS");
  assert.equal(fileSha256(path.join(runtime, "node/node.exe")), manifest.nodeSha256, "Bundled Node hash mismatch");
  assert.equal(fileSha256(path.join(runtime, "binaries/crownforge-ide-core.exe")), manifest.ideCoreSha256, "Bundled Rust Core hash mismatch");
  return manifest;
}

export function assertGitManifestFields(manifest, gitRuntime) {
  assert.equal(manifest.gitVersion, gitRuntime.manifest.gitVersion, "Package and Git receipts disagree on version");
  assert.equal(manifest.gitExecutable, `git/${gitRuntime.executableRelative}`, "Package and Git receipts disagree on executable");
  assert.equal(manifest.gitSha256, gitRuntime.manifest.files[gitRuntime.executableRelative], "Package and Git receipts disagree on executable hash");
  assert.equal(fileSha256(gitRuntime.executable), manifest.gitSha256, "Installed Git differs from the package manifest");
}

export function collectOwnedProcesses(records, identities) {
  const matches = (entry, identity) => identity && entry.ExecutablePath?.toLowerCase() === identity.executable && entry.CreatedUtc === identity.created;
  const owned = new Map(records.filter((entry) => matches(entry, identities.get(entry.ProcessId))).map((entry) => [entry.ProcessId, entry]));
  let changed;
  do {
    changed = false;
    for (const entry of records) {
      const parent = owned.get(entry.ParentProcessId);
      if (owned.has(entry.ProcessId) || !parent || !entry.ExecutablePath || !entry.CreatedUtc) continue;
      // A stale child can retain a now-reused parent PID. It predates the
      // trusted parent's exact creation identity and cannot belong to this run.
      if (!Number.isFinite(Date.parse(entry.CreatedUtc)) || Date.parse(entry.CreatedUtc) < Date.parse(parent.CreatedUtc)) continue;
      owned.set(entry.ProcessId, entry); changed = true;
    }
  } while (changed);
  return [...owned.values()];
}

export async function runCleanupSteps(steps) {
  const failures = [];
  for (const [stage, work] of steps) {
    try { await work(); }
    catch { failures.push(stage); }
  }
  return failures;
}

export function windowsPowerShellEnvironment(environment) {
  const get = (name) => Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const systemRoot = get("SystemRoot"), programFiles = get("ProgramFiles");
  assert.ok(systemRoot && path.win32.isAbsolute(systemRoot), "WinPS5 system root is required");
  assert.ok(programFiles && path.win32.isAbsolute(programFiles), "WinPS5 Program Files root is required");
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  // The parent job uses pwsh 7. Its module search path must not make the WinPS5
  // helper load Core/.NET assemblies from the PowerShell 7 installation.
  result.PSModulePath = [
    path.win32.join(systemRoot, "System32/WindowsPowerShell/v1.0/Modules"),
    path.win32.join(programFiles, "WindowsPowerShell/Modules"),
  ].join(";");
  return result;
}
