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

export function minGitPeDependencies(file) {
  // Read only the loader's import metadata. The pinned MinGit launchers retain
  // an unmapped debug directory that makes dumpbin reject the entire image.
  // Format: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
  assert.ok(fs.lstatSync(file).isFile(), "MinGit PE must be a regular file");
  assert.ok(fs.statSync(file).size <= 64 * 1024 * 1024, "MinGit PE exceeds its inspection bound");
  const bytes = fs.readFileSync(file);
  const span = (offset, size) => {
    assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && offset <= bytes.length - size, "PE table is truncated or outside the file");
    return offset;
  };
  const u16 = (offset) => bytes.readUInt16LE(span(offset, 2));
  const u32 = (offset) => bytes.readUInt32LE(span(offset, 4));
  assert.equal(bytes.toString("ascii", span(0, 64), 2), "MZ", "PE DOS signature mismatch");
  const pe = u32(0x3c); assert.ok(pe >= 64); span(pe, 24);
  assert.equal(bytes.toString("ascii", pe, pe + 4), "PE\0\0", "PE signature mismatch");
  assert.equal(u16(pe + 4), 0x8664, "MinGit imports require Windows x64 PE");
  const count = u16(pe + 6), optionalSize = u16(pe + 20), optional = pe + 24;
  assert.ok(count > 0 && count <= 96, "PE section count exceeds the Windows loader bound");
  span(optional, optionalSize); assert.ok(optionalSize >= 112, "PE optional header is truncated");
  assert.equal(u16(optional), 0x20b, "MinGit imports require a PE32+ optional header");
  const directoryCount = u32(optional + 108);
  assert.ok(directoryCount >= 14 && directoryCount <= 16 && optionalSize >= 112 + directoryCount * 8, "PE import data directories are truncated");
  const imageSize = u32(optional + 56), headerSize = u32(optional + 60);
  const sectionTable = optional + optionalSize; span(sectionTable, count * 40);
  assert.ok(headerSize >= sectionTable + count * 40 && headerSize <= bytes.length && imageSize >= headerSize, "PE image/header bounds are invalid");
  const sections = [];
  for (let index = 0; index < count; index++) {
    const entry = sectionTable + index * 40;
    const virtualSize = u32(entry + 8), rva = u32(entry + 12), rawSize = u32(entry + 16), raw = u32(entry + 20);
    const size = Math.max(virtualSize, rawSize);
    assert.ok(rva >= headerSize && rva <= imageSize - size, "PE section RVA exceeds the image");
    if (rawSize) { span(raw, rawSize); assert.ok(raw >= headerSize, "PE section overlaps its headers"); }
    assert.ok(!sections.some((section) => rva < section.rva + section.size && section.rva < rva + size), "PE virtual sections overlap");
    sections.push({ rva, size, raw, rawSize });
  }
  const mapped = (rva, size) => {
    assert.ok(Number.isSafeInteger(rva) && rva > 0 && rva <= imageSize - size, "PE RVA exceeds the image");
    if (rva < headerSize) { assert.ok(rva <= headerSize - size, "PE RVA crosses the headers"); return { offset: span(rva, size), remaining: headerSize - rva }; }
    const section = sections.find((entry) => rva >= entry.rva && rva < entry.rva + entry.size);
    assert.ok(section && rva - section.rva <= section.rawSize - size, "PE RVA has no complete file-backed section mapping");
    return { offset: span(section.raw + rva - section.rva, size), remaining: section.rawSize - (rva - section.rva) };
  };
  const readName = (rva, max, dll = false) => {
    const { offset, remaining } = mapped(rva, 1), limit = offset + Math.min(remaining, max);
    const end = bytes.indexOf(0, offset);
    assert.ok(end > offset && end < limit, "PE import name is empty, unterminated or exceeds its bound");
    assert.ok(bytes.subarray(offset, end).every((byte) => byte >= 0x21 && byte <= 0x7e), "PE import name is not printable ASCII");
    const name = bytes.toString("ascii", offset, end);
    if (dll) assert.match(name, /^[A-Za-z0-9_.+-]+\.dll$/i, "PE imported DLL name is invalid");
    return name;
  };
  const imageBase = bytes.readBigUInt64LE(span(optional + 24, 8));
  const addressRva = (value, rvaBased = true) => {
    const rva = rvaBased ? BigInt(value) : BigInt(value) - imageBase;
    assert.ok(rva > 0n && rva <= 0xffffffffn, "PE import address cannot be represented as an RVA");
    return Number(rva);
  };
  const verifyThunks = (lookup, iat, rvaBased = true) => {
    assert.ok(lookup && iat, "PE import thunk tables are missing");
    for (let index = 0; index < 65536; index++) {
      const source = bytes.readBigUInt64LE(mapped(lookup + index * 8, 8).offset);
      const target = bytes.readBigUInt64LE(mapped(iat + index * 8, 8).offset);
      if (source === 0n) { assert.equal(target, 0n, "PE import address table lacks its terminator"); return (index + 1) * 8; }
      if (source & 0x8000000000000000n) assert.equal(source & 0x7fffffffffff0000n, 0n, "PE ordinal import has reserved bits");
      else { const nameRva = addressRva(source, rvaBased); mapped(nameRva, 2); readName(nameRva + 2, 4096); }
    }
    throw new Error("PE import thunk table exceeds its bound");
  };
  const directory = (index) => ({ rva: u32(optional + 112 + index * 8), size: u32(optional + 116 + index * 8) });
  const imports = [], delayImports = [];
  for (const [index, descriptorSize, names] of [[1, 20, imports], [13, 32, delayImports]]) {
    const table = directory(index);
    if (!table.rva && !table.size) continue;
    assert.ok(table.rva && table.size >= descriptorSize && table.size <= 8 * 1024 * 1024, "PE import descriptor directory is invalid");
    const start = mapped(table.rva, table.size).offset;
    let terminated = false;
    for (let offset = 0; offset <= table.size - descriptorSize && offset / descriptorSize < 4096; offset += descriptorSize) {
      const values = Array.from({ length: descriptorSize / 4 }, (_, field) => u32(start + offset + field * 4));
      if (values.every((value) => value === 0)) { terminated = true; break; }
      if (index === 1) {
        names.push(readName(values[3], 260, true));
        assert.ok(values[0] || !values[1], "Bound PE import has no original lookup table");
        verifyThunks(values[0] || values[4], values[4]);
      } else {
        assert.ok(values[0] === 0 || values[0] === 1, "PE delay-import attributes have reserved bits");
        const rvaBased = values[0] === 1;
        names.push(readName(addressRva(values[1], rvaBased), 260, true));
        mapped(addressRva(values[2], rvaBased), 8);
        const thunkBytes = verifyThunks(addressRva(values[4], rvaBased), addressRva(values[3], rvaBased), rvaBased);
        for (const field of [5, 6]) if (values[field]) mapped(addressRva(values[field], rvaBased), thunkBytes);
      }
    }
    assert.ok(terminated, "PE import descriptor table has no bounded terminator");
  }
  assert.ok(imports.length || delayImports.length, "PE contains no import dependency evidence");
  const debug = directory(6); let debugDirectoryIssue;
  if (debug.rva || debug.size) {
    try { assert.ok(debug.rva && debug.size); mapped(debug.rva, debug.size); }
    catch { debugDirectoryIssue = { rva: debug.rva, size: debug.size, reason: "debug-directory-has-no-complete-file-backed-mapping" }; }
  }
  return { names: [...new Set([...imports, ...delayImports])], imports: [...new Set(imports)], delayImports: [...new Set(delayImports)], inspectionMethod: "raw-pe-import-and-delay-import-directories", ...(debugDirectoryIssue ? { debugDirectoryIssue } : {}) };
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
