import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SDK_PRODUCER, validateSdkProducer, nsisDefinitions, peMachine, dumpbinDependencies, classifyDependency, assertInstalledHostPayload, assertGitManifestFields, collectOwnedProcesses, runCleanupSteps, minGitDllDirectories, windowsPowerShellEnvironment } from "./windows-package-validation.mjs";
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
  assert.deepEqual(minGitDllDirectories(path.join(root, "ucrt64/libexec/git-core/git-remote-http.exe"), root), [path.join(root, "ucrt64/libexec/git-core"), path.join(root, "ucrt64/bin")]);
  assert.throws(() => minGitDllDirectories(path.resolve("outside.exe"), root));
  assert.throws(() => minGitDllDirectories(path.join(root, "another/bin/unknown.exe"), root));
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
