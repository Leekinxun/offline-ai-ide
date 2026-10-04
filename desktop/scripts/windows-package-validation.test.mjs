import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { SDK_PRODUCER, validateSdkProducer, nsisDefinitions, peMachine, dumpbinDependencies, minGitPeDependencies, classifyDependency, assertInstalledHostPayload, assertGitManifestFields, collectOwnedProcesses, runCleanupSteps, minGitDllDirectories, minGitSmokeExecutables, windowsPowerShellEnvironment, powerShellPackageProbes, terminalDisplayText, observeTerminalClose } from "./windows-package-validation.mjs";
import crypto from "node:crypto";
import { writeVerifiedArchive } from "./windows-package-sdk-artifact.mjs";

test("SDK packaging rejects unfinished, wrong-source, expired and different-lock producer artifacts", () => {
  const run = { id: SDK_PRODUCER.runId, repository: { full_name: SDK_PRODUCER.repository }, head_repository: { full_name: SDK_PRODUCER.repository }, path: SDK_PRODUCER.workflowPath, head_branch: SDK_PRODUCER.branch, head_sha: SDK_PRODUCER.sourceCommit, status: "completed", conclusion: "success" };
  const artifact = { id: 123, name: `crownforge-codex-runtime-${run.id}`, expired: false, digest: `sha256:${"a".repeat(64)}`, workflow_run: { id: run.id, head_sha: run.head_sha } };
  const lock = { patchSha256: "b".repeat(64), assets: { x64: { sha256: "c".repeat(64) } } };
  assert.equal(validateSdkProducer(run, artifact, lock, structuredClone(lock)).artifactId, artifact.id);
  for (const change of [{ status: "in_progress" }, { conclusion: "failure" }, { head_sha: "d".repeat(40) }, { head_repository: { full_name: "another/repository" } }]) assert.throws(() => validateSdkProducer({ ...run, ...change }, artifact, lock, lock));
  assert.throws(() => validateSdkProducer(run, { ...artifact, expired: true }, lock, lock));
  assert.throws(() => validateSdkProducer(run, artifact, lock, { ...lock, patchSha256: "d".repeat(64) }));
});

test("NSIS checks the effective offline mode and embedded standalone payload while allowing unrelated conditional defines", () => {
  const source = '\uFEFF!define ARCH "x64"\r\n!define INSTALLWEBVIEW2MODE "offlineInstaller"\r\n!define WEBVIEW2INSTALLERPATH "C:\\cache\\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"\r\n!define MUI_HEADERIMAGE_BITMAP "one"\r\n!define MUI_HEADERIMAGE_BITMAP "two"\r\nFile "/oname=$TEMP\\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"\r\n';
  assert.equal(nsisDefinitions(source).ARCH, "x64");
  assert.throws(() => nsisDefinitions(source.replace('"offlineInstaller"', '"embedBootstrapper"')));
  assert.throws(() => nsisDefinitions(source.replace('File "/oname=', 'File "missing=')));
  assert.throws(() => nsisDefinitions(`${source}!define ARCH "arm64"\n`));
});

test("PE reads reject truncated headers and offsets outside the actual file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-package-validation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "owned.exe");
  const bytes = Buffer.alloc(160); bytes.write("MZ"); bytes.writeUInt32LE(128, 0x3c); bytes.write("PE\0\0", 128); bytes.writeUInt16LE(0x8664, 132);
  fs.writeFileSync(file, bytes); assert.equal(peMachine(file), 0x8664);
  bytes.writeUInt32LE(999, 0x3c); fs.writeFileSync(file, bytes); assert.throws(() => peMachine(file));
  fs.writeFileSync(file, Buffer.from("MZ")); assert.throws(() => peMachine(file));
});

test("dependency checks do not accept runner-installed VC runtime or unknown DLLs", () => {
  // The source-built WFP boundary imports the documented Windows OS client.
  assert.equal(classifyDependency("FWPUCLNT.dll", new Set()), "windows-os");
  assert.equal(classifyDependency("tdh.dll", new Set()), "windows-os");
  assert.equal(classifyDependency("MMDEVAPI.dll", new Set()), "windows-os");
  assert.throws(() => classifyDependency("FWP-unknown.dll", new Set()));
  const names = dumpbinDependencies("Header\n KERNEL32.dll\n VCRUNTIME140_1.dll\n\nSummary\n");
  assert.deepEqual(names, ["KERNEL32.dll", "VCRUNTIME140_1.dll"]);
  assert.equal(classifyDependency("KERNEL32.dll", new Set()), "windows-os");
  assert.equal(classifyDependency("api-ms-win-crt-runtime-l1-1-0.dll", new Set()), "windows-os");
  assert.throws(() => classifyDependency("VCRUNTIME140_1.dll", new Set()));
  assert.equal(classifyDependency("VCRUNTIME140_1.dll", new Set(["vcruntime140_1.dll"])), "packaged");
  assert.throws(() => classifyDependency("unverified.dll", new Set()));
  assert.throws(() => classifyDependency("../outside.dll", new Set()));
});

function importFixture() {
  const bytes = Buffer.alloc(2048), pe = 128, optional = pe + 24, section = optional + 240;
  bytes.write("MZ"); bytes.writeUInt32LE(pe, 0x3c); bytes.write("PE\0\0", pe); bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(240, pe + 20);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeBigUInt64LE(0x140000000n, optional + 24); bytes.writeUInt32LE(0x2000, optional + 56); bytes.writeUInt32LE(512, optional + 60); bytes.writeUInt32LE(16, optional + 108);
  bytes.write(".idata", section); bytes.writeUInt32LE(1536, section + 8); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(1536, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(0x1000, optional + 120); bytes.writeUInt32LE(40, optional + 124);
  bytes.writeUInt32LE(0x1180, 512); bytes.writeUInt32LE(0x1100, 524); bytes.writeUInt32LE(0x11a0, 528); bytes.write("KERNEL32.dll\0", 768);
  bytes.writeBigUInt64LE(0x11c0n, 896); bytes.writeBigUInt64LE(0x11c0n, 928); bytes.write("OwnFunction\0", 962);
  bytes.writeUInt32LE(0x1200, optional + 112 + 13 * 8); bytes.writeUInt32LE(64, optional + 116 + 13 * 8);
  [1, 0x1300, 0x1320, 0x1340, 0x1360, 0, 0, 0].forEach((value, index) => bytes.writeUInt32LE(value, 1024 + index * 4));
  bytes.write("fixture-delay.dll\0", 1280); bytes.writeBigUInt64LE(0x1380n, 1344); bytes.writeBigUInt64LE(0x1380n, 1376); bytes.write("DelayedFunction\0", 1410);
  // Match the upstream launcher's unrelated orphaned debug-directory shape.
  bytes.writeUInt32LE(0x3000, optional + 112 + 6 * 8); bytes.writeUInt32LE(28, optional + 116 + 6 * 8);
  return bytes;
}

test("raw MinGit PE inspection includes delay imports without modifying orphaned debug metadata or hiding unknown DLLs", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-pe-imports-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "owned.exe"), bytes = importFixture(); fs.writeFileSync(file, bytes);
  const result = minGitPeDependencies(file);
  assert.deepEqual(result.imports, ["KERNEL32.dll"]); assert.deepEqual(result.delayImports, ["fixture-delay.dll"]);
  assert.deepEqual(result.names, ["KERNEL32.dll", "fixture-delay.dll"]);
  assert.equal(result.inspectionMethod, "raw-pe-import-and-delay-import-directories"); assert.equal(result.debugDirectoryIssue.rva, 0x3000);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => classifyDependency(result.delayImports[0], new Set()), /no explicit Windows OS or packaged resolution/);
  // The documented legacy delay descriptor uses VAs, rather than RVAs.
  const legacy = Buffer.from(bytes); legacy.writeBigUInt64LE(0x400000n, 176); legacy.writeUInt32LE(0, 1024);
  for (const field of [1, 2, 3, 4]) legacy.writeUInt32LE(legacy.readUInt32LE(1024 + field * 4) + 0x400000, 1024 + field * 4);
  legacy.writeBigUInt64LE(0x401380n, 1376); fs.writeFileSync(file, legacy);
  assert.deepEqual(minGitPeDependencies(file).delayImports, ["fixture-delay.dll"]);
});

test("raw PE imports fail closed for truncated headers, unmapped tables, names, thunk and descriptor boundaries", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-pe-invalid-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "owned.exe"), optional = 152, section = 392;
  const mutations = [
    ["truncated DOS", (b) => b.subarray(0, 63)],
    ["bad PE offset", (b) => { b.writeUInt32LE(9999, 0x3c); return b; }],
    ["wrong machine", (b) => { b.writeUInt16LE(0x14c, 132); return b; }],
    ["truncated optional header", (b) => { b.writeUInt16LE(120, 148); return b; }],
    ["missing delay directory", (b) => { b.writeUInt32LE(13, optional + 108); return b; }],
    ["raw section escapes file", (b) => { b.writeUInt32LE(2000, section + 20); return b; }],
    ["unmapped import directory", (b) => { b.writeUInt32LE(0x1800, optional + 120); return b; }],
    ["directory crosses raw section", (b) => { b.writeUInt32LE(0x15f8, optional + 120); return b; }],
    ["unmapped DLL name", (b) => { b.writeUInt32LE(0x3000, 524); return b; }],
    ["unterminated DLL name", (b) => { b.fill(65, 768); return b; }],
    ["invalid DLL path", (b) => { b.write("../outside.dll\0", 768); return b; }],
    ["descriptor lacks bounded terminator", (b) => { b.writeUInt32LE(20, optional + 124); return b; }],
    ["unmapped thunk table", (b) => { b.writeUInt32LE(0x3000, 512); return b; }],
    ["unmapped symbol name", (b) => { b.writeBigUInt64LE(0x3000n, 896); return b; }],
    ["IAT lacks terminator", (b) => { b.writeBigUInt64LE(1n, 936); return b; }],
    ["delay descriptor lacks terminator", (b) => { b.writeUInt32LE(32, optional + 116 + 13 * 8); return b; }],
    ["delay attributes reserved", (b) => { b.writeUInt32LE(2, 1024); return b; }],
    ["unmapped delay DLL", (b) => { b.writeUInt32LE(0x3000, 1028); return b; }],
    ["unmapped delay INT", (b) => { b.writeUInt32LE(0x3000, 1040); return b; }],
    ["truncated delay bound table", (b) => { b.writeUInt32LE(0x15f8, 1044); return b; }],
  ];
  for (const [label, mutate] of mutations) { fs.writeFileSync(file, mutate(importFixture())); assert.throws(() => minGitPeDependencies(file), undefined, label); }
});

test("artifact bytes are published only after matching their exact digest and size limit", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-sdk-archive-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "owned.zip"), bytes = Buffer.from("owned disposable archive fixture");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal((await writeVerifiedArchive(new Response(bytes), file, hash)).sha256, hash);
  assert.deepEqual(fs.readFileSync(file), bytes);
  fs.rmSync(file);
  await assert.rejects(writeVerifiedArchive(new Response(bytes), file, "0".repeat(64)), /SHA-256 mismatch/);
  await assert.rejects(writeVerifiedArchive(new Response(bytes), file, hash, 4), /archive limit/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("Git package version, path and file bytes must agree with the verified Git receipt", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-package-git-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "git.exe"); fs.writeFileSync(executable, "owned executable fixture");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  const git = { executable, executableRelative: "cmd/git.exe", manifest: { gitVersion: "fixture-version", files: { "cmd/git.exe": hash } } };
  const manifest = { gitVersion: "fixture-version", gitExecutable: "git/cmd/git.exe", gitSha256: hash };
  assertGitManifestFields(manifest, git);
  for (const change of [{ gitVersion: "wrong" }, { gitExecutable: "git/bin/git.exe" }, { gitSha256: "0".repeat(64) }]) assert.throws(() => assertGitManifestFields({ ...manifest, ...change }, git));
  fs.appendFileSync(executable, "changed"); assert.throws(() => assertGitManifestFields(manifest, git));
});

test("process ownership excludes reused parent PIDs, older children and unrelated system WebView2", () => {
  const created = (second) => `2026-10-04T00:00:${String(second).padStart(2, "0")}.000Z`;
  const parent = { ProcessId: 10, ParentProcessId: 1, ExecutablePath: "C:/fixture/setup.exe", CreatedUtc: created(10) };
  const child = { ProcessId: 20, ParentProcessId: 10, ExecutablePath: "C:/fixture/owned-webview-installer.exe", CreatedUtc: created(11) };
  const system = { ProcessId: 30, ParentProcessId: 4, ExecutablePath: "C:/Windows/system-webview.exe", CreatedUtc: created(11) };
  const stale = { ProcessId: 40, ParentProcessId: 10, ExecutablePath: "C:/other/older.exe", CreatedUtc: created(9) };
  const identities = new Map([[10, { executable: parent.ExecutablePath.toLowerCase(), created: parent.CreatedUtc }]]);
  assert.deepEqual(collectOwnedProcesses([parent, child, system, stale], identities).map((entry) => entry.ProcessId), [10, 20]);
  assert.deepEqual(collectOwnedProcesses([{ ...parent, CreatedUtc: created(12) }, child, system], identities), []);
});

test("cleanup continues through independent failures and records each failing stage", async () => {
  const completed = [];
  const failures = await runCleanupSteps([
    ["backend", async () => { throw new Error("owned backend cleanup failed"); }],
    ["host", async () => { completed.push("host"); }],
    ["installer", async () => { throw new Error("owned installer cleanup failed"); }],
    ["fixture", async () => { completed.push("fixture"); }],
  ]);
  assert.deepEqual(completed, ["host", "fixture"]);
  assert.deepEqual(failures, ["backend", "installer"]);
});

test("MinGit dependency resolution is scoped to its actual ucrt64 and usr loader directories", () => {
  const root = path.resolve("owned-min-git");
  assert.deepEqual(minGitDllDirectories(path.join(root, "cmd/git.exe"), root), [path.join(root, "cmd")]);
  assert.deepEqual(minGitDllDirectories(path.join(root, "usr/bin/sh.exe"), root), [path.join(root, "usr/bin")]);
  assert.deepEqual(minGitDllDirectories(path.join(root, "ucrt64/bin/git.exe"), root), [path.join(root, "ucrt64/bin")]);
  assert.deepEqual(minGitDllDirectories(path.join(root, "ucrt64/bin/git-remote-http.exe"), root), [path.join(root, "ucrt64/bin")]);
  assert.throws(() => minGitDllDirectories(path.join(root, "ucrt64/libexec/git-core/git-remote-http.exe"), root));
  assert.throws(() => minGitDllDirectories(path.resolve("outside.exe"), root));
  assert.throws(() => minGitDllDirectories(path.join(root, "another/bin/unknown.exe"), root));
});

test("MinGit executable inspection uses the installed ucrt64 HTTP launcher and binds its receipt bytes and PE architecture", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-mingit-layout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {};
  const bytes = Buffer.alloc(160); bytes.write("MZ"); bytes.writeUInt32LE(128, 0x3c); bytes.write("PE\0\0", 128); bytes.writeUInt16LE(0x8664, 132);
  for (const relative of ["ucrt64/bin/git.exe", "usr/bin/sh.exe", "ucrt64/bin/git-remote-http.exe"]) {
    const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    files[relative] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  const git = { directory, manifest: { files } };
  const executables = minGitSmokeExecutables(git);
  assert.equal(executables.gitHttp, path.join(directory, "ucrt64/bin/git-remote-http.exe"));
  const wrongFiles = { ...files }; delete wrongFiles["ucrt64/bin/git-remote-http.exe"];
  wrongFiles["ucrt64/libexec/git-core/git-remote-http.exe"] = files["ucrt64/bin/git-remote-http.exe"];
  assert.throws(() => minGitSmokeExecutables({ directory, manifest: { files: wrongFiles } }), /absent from its verified receipt/);
  fs.appendFileSync(executables.gitHttp, "changed");
  assert.throws(() => minGitSmokeExecutables(git), /differs from its verified receipt/);
  bytes.writeUInt16LE(0x14c, 132); fs.writeFileSync(executables.gitHttp, bytes);
  files["ucrt64/bin/git-remote-http.exe"] = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.throws(() => minGitSmokeExecutables(git), /Windows x64 PE/);
});

test("WinPS5 helpers discard inherited pwsh7 module paths while preserving other environment values", () => {
  const original = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: "unchanged-command-path", LANG: "fixture-locale",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules;C:\\Users\\fixture\\Documents\\PowerShell\\Modules", psmodulepath: "another-inherited-spelling" };
  const prepared = windowsPowerShellEnvironment(original);
  assert.equal(prepared.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules");
  assert.deepEqual(Object.keys(prepared).filter((key) => key.toLowerCase() === "psmodulepath"), ["PSModulePath"]);
  assert.equal(prepared.PATH, original.PATH); assert.equal(prepared.LANG, original.LANG);
  assert.match(original.PSModulePath, /PowerShell\\7\\Modules/);
  assert.throws(() => windowsPowerShellEnvironment({ ProgramFiles: original.ProgramFiles }));
});

test("PowerShell execution markers cannot be satisfied by command echo and require separate ASCII and intact Unicode results", () => {
  const probes = powerShellPackageProbes();
  for (const probe of Object.values(probes)) {
    const echo = `\x1b[32mPS C:\\owned> ${probe.command}\x1b[0m\r\n`;
    assert.equal(terminalDisplayText(echo).includes(probe.marker), false);
    assert.equal(terminalDisplayText(`${echo}\x1b[37m${probe.marker}\x1b[0m\r\n`).includes(probe.marker), true);
  }
  assert.equal(terminalDisplayText(probes.ascii.marker).includes(probes.utf8.marker), false);
  assert.equal(terminalDisplayText(probes.utf8.marker.replace("中文", "??")).includes(probes.utf8.marker), false);
});

test("terminal close observation survives exit-plus-close before polling and handles an early error before awaiting", async () => {
  const socket = new EventEmitter(), frames = [], closed = observeTerminalClose(socket);
  socket.on("message", (frame) => frames.push(frame));
  // TerminalSessions sends exit and then closes; a 20ms polling consumer may
  // observe both only later. No second close event is needed to settle the test.
  socket.emit("message", { type: "exit" }); socket.emit("close", 1000, "user_closed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(frames.some((frame) => frame.type === "exit"));
  assert.deepEqual(await closed, [1000, "user_closed"]);
  const failedSocket = new EventEmitter(), failed = observeTerminalClose(failedSocket);
  failedSocket.emit("error", new Error("owned fixture early transport error"));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(failed, /owned fixture early transport error/);
});

test("installed Host must match the unique final NSIS payload, independently of restored build-input bytes", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-nsis-host-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const extraction = path.join(directory, "extracted"); fs.mkdirSync(extraction);
  const payload = path.join(extraction, "crownforge-desktop.exe"), input = path.join(directory, "build.exe"), installed = path.join(directory, "installed.exe");
  const bytes = Buffer.alloc(180); bytes.write("MZ"); bytes.writeUInt32LE(128, 0x3c); bytes.write("PE\0\0", 128); bytes.writeUInt16LE(0x8664, 132);
  fs.writeFileSync(input, bytes);
  bytes.write("NSIS-bundle-payload", 144); fs.writeFileSync(payload, bytes); fs.writeFileSync(installed, bytes);
  const options = { extractedFiles: [payload], extractRoot: extraction, mainBinaryName: "crownforge-desktop", installedHost: installed, originalBuildInput: input };
  const evidence = assertInstalledHostPayload(options);
  assert.equal(evidence.embeddedPayloadSha256, evidence.installedSha256);
  assert.notEqual(evidence.originalBuildInputSha256, evidence.embeddedPayloadSha256);
  assert.throws(() => assertInstalledHostPayload({ ...options, extractedFiles: [payload, payload] }), /exactly one/);
  assert.throws(() => assertInstalledHostPayload({ ...options, mainBinaryName: "../outside" }));
  fs.appendFileSync(installed, "changed"); assert.throws(() => assertInstalledHostPayload(options), /exact final NSIS payload/);
  fs.writeFileSync(installed, bytes); bytes.writeUInt16LE(0x14c, 132); fs.writeFileSync(payload, bytes);
  assert.throws(() => assertInstalledHostPayload(options), /x64 PE/);
});
