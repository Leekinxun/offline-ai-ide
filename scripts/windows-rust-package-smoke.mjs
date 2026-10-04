// Disposable GitHub-hosted Windows VM acceptance. This never removes WebView2,
// invokes model services, changes firewall policy, or claims a clean offline VM.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import http from "node:http";
import { fileSha256 } from "../desktop/scripts/build-crownforge-codex-runtime.mjs";
import { verifyCodexRuntime } from "../desktop/scripts/prepare-codex-runtime.mjs";
import { verifyGitRuntime } from "../desktop/scripts/prepare-git-runtime.mjs";
import { SDK_PRODUCER, nsisDefinitions, peMachine, filesUnder, dumpbinDependencies, classifyDependency, assertRuntimeManifest, assertGitManifestFields, collectOwnedProcesses, runCleanupSteps, minGitDllDirectories } from "../desktop/scripts/windows-package-validation.mjs";

assert.equal(process.platform, "win32", "Package acceptance must run on real Windows");
assert.ok(process.argv.includes("--allow-disposable-install"), "Installation requires --allow-disposable-install");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Installation is limited to the explicitly authorized CI VM");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "A disposable GitHub-hosted VM is required");
assert.equal(process.env.GITHUB_REPOSITORY, SDK_PRODUCER.repository);
assert.equal(process.env.GITHUB_REF, "refs/heads/APP_RUST");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDirectory = path.join(project, ".artifacts/app-rust-package");
fs.mkdirSync(reportDirectory, { recursive: true });
const runnerTemp = fs.realpathSync.native(process.env.RUNNER_TEMP);
const fixture = fs.mkdtempSync(path.join(runnerTemp, "crownforge-nsis-"));
const installation = path.join(fixture, "installed");
const extractRoot = path.join(fixture, "extracted");
const definitionsFile = path.join(project, "desktop/rust/target/release/nsis/x64/installer.nsi");
let installer;
const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const taskkill = path.join(process.env.SystemRoot, "System32/taskkill.exe");
const sevenZip = path.join(process.env.ProgramFiles, "7-Zip/7z.exe");
const execute = promisify(execFile);
const report = {
  schemaVersion: 1, status: "failed", platform: "win32", architecture: "x64",
  sourceCommit: process.env.GITHUB_SHA, sdkProducer: SDK_PRODUCER,
  scope: "NSIS payload, disposable installation, packaged Host/Node/Core/backend and shutdown on windows-2022",
  cleanMissingWebView2Verified: false, completeOfflineInstallationVerified: false,
  publicNetworkIsolationVerified: false, guiVisualVerified: false,
  modelWeightsIncluded: false, modelServiceInvoked: false,
  checks: [],
};
let stage = "package provenance";
let child;
let childClosed;
let host;
let hostClosed;
let socket;
let lines;
let bootstrapToken = "";
let bearer = "";
let backendLog = "";
let installed = false;
let runtime;
let gitRuntime;
const ownedIdentities = new Map();
const ownedRoots = new Map();
const installerChildren = [];

const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function bounded(promise, milliseconds = 20_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${stage} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function command(executable, args, timeout = 60_000, options = {}) {
  const result = await execute(executable, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, ...options });
  return result.stdout;
}
async function ps(code, timeout) {
  return command(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${code}`], timeout);
}
async function psJson(code) {
  const value = (await ps(`${code} | ConvertTo-Json -Depth 6 -Compress`)).replace(/^\uFEFF/, "").trim();
  return value ? JSON.parse(value) : null;
}
function rememberRoot(processChild, executable, startedAt) {
  assert.ok(processChild?.pid && processChild.pid !== process.pid);
  ownedRoots.set(processChild.pid, { child: processChild, executable: fs.realpathSync.native(executable).toLowerCase(), startedAt });
}
async function matchingOwnedProcesses() {
  const current = await psJson(`@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,Name,@{Name='CreatedUtc';Expression={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}})`);
  const records = current ? (Array.isArray(current) ? current : [current]) : [];
  for (const [pid, root] of ownedRoots) {
    if (ownedIdentities.has(pid) || root.child.exitCode !== null || root.child.signalCode !== null) continue;
    const row = records.find((entry) => entry.ProcessId === pid && entry.ExecutablePath?.toLowerCase() === root.executable);
    if (row && Date.parse(row.CreatedUtc) >= root.startedAt - 1000 && Date.parse(row.CreatedUtc) <= Date.now() + 1000) {
      ownedIdentities.set(pid, { executable: root.executable, created: row.CreatedUtc });
    }
  }
  const entries = collectOwnedProcesses(records, ownedIdentities);
  for (const entry of entries) ownedIdentities.set(entry.ProcessId, { executable: entry.ExecutablePath.toLowerCase(), created: entry.CreatedUtc });
  return entries;
}
async function processSnapshot(rootPid) {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0 && rootPid !== process.pid);
  const records = await matchingOwnedProcesses();
  return collectOwnedProcesses(records, new Map([[rootPid, ownedIdentities.get(rootPid)]]));
}
async function forceOwnedTree(processChild) {
  if (!processChild?.pid || processChild.exitCode !== null || processChild.signalCode !== null) return;
  let known;
  try { known = await matchingOwnedProcesses(); }
  catch { processChild.kill("SIGKILL"); throw new Error("Owned tree identity query failed"); }
  if (!known.some((entry) => entry.ProcessId === processChild.pid)) {
    // The original ChildProcess handle is safe to stop, but no unproven PID
    // tree or unrelated system WebView2 process may be targeted.
    processChild.kill("SIGKILL");
    throw new Error("Owned process-tree identity could not be established");
  }
  await command(taskkill, ["/PID", String(processChild.pid), "/T", "/F"], 10_000);
}
async function installerCommand(executable, args, timeout, options = {}) {
  const startedAt = Date.now();
  const pending = execute(executable, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });
  void pending.catch(() => {});
  const processChild = pending.child;
  rememberRoot(processChild, executable, startedAt); installerChildren.push(processChild);
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try { await matchingOwnedProcesses(); } finally { refreshing = false; }
  };
  const timer = setInterval(() => { void refresh().catch(() => {}); }, 1000);
  try {
    await refresh();
    return await bounded(pending, timeout);
  } catch (error) {
    if (processChild.exitCode === null && processChild.signalCode === null) await forceOwnedTree(processChild);
    throw error;
  } finally { clearInterval(timer); }
}
function fixtureEnvironment(data) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG"]) if (process.env[key]) env[key] = process.env[key];
  assert.ok(gitRuntime, "Verified installed Git is required for package execution");
  return { ...env, HOME: data, USERPROFILE: data, TMP: data, TEMP: data,
    PATH: [...gitRuntime.binDirectories, path.join(process.env.SystemRoot, "System32"), path.dirname(powershell), process.env.SystemRoot].join(path.delimiter),
    CROWNFORGE_GIT_EXECUTABLE: gitRuntime.executable, CROWNFORGE_GIT_RUNTIME_ROOT: gitRuntime.directory, CROWNFORGE_BUNDLED_TOOLS_REQUIRED: "1",
    NODE_ENV: "production", VLLM_API_URL: "http://127.0.0.1:9/v1", VLLM_API_KEY: "", MODEL_NAME: "default",
    MCP_BASE_URLS: "", MCP_SERVERS_CONFIG: "[]", CREWFORGE_DESKTOP_DATA_DIR: data };
}
function prepareData(name) {
  const data = path.join(fixture, name), workspace = path.join(data, "workspace"), plugins = path.join(data, "plugins");
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(plugins);
  fs.writeFileSync(path.join(workspace, "package.txt"), "Packaged Windows UTF-8 中文\n");
  const users = path.join(data, "users.json");
  fs.writeFileSync(users, JSON.stringify({ allowedRoots: [data], pendingRegistrations: [], users: [{ username: "package-fixture", password: crypto.randomBytes(24).toString("hex"), defaultWorkspace: workspace, isAdmin: true }] }));
  fs.writeFileSync(path.join(data, "app-settings.json"), "{}\n");
  return { data, workspace, plugins, users };
}

try {
  const installers = fs.readdirSync(path.join(project, "desktop/rust/target/release/bundle/nsis")).filter((name) => name.endsWith("-setup.exe"));
  assert.equal(installers.length, 1, "Exactly one ordinary NSIS installer is required");
  installer = path.join(project, "desktop/rust/target/release/bundle/nsis", installers[0]);
  const provenance = JSON.parse(fs.readFileSync(path.join(reportDirectory, "sdk-provenance.json"), "utf8"));
  assert.deepEqual(provenance.producer, SDK_PRODUCER);
  assert.equal(provenance.packageCommit, process.env.GITHUB_SHA);
  assert.ok(!fs.existsSync(path.join(project, ".artifacts/cf-src")), "Packaging must not clone or compile SDK sources");
  report.sdkArtifact = { id: provenance.artifactId, digest: provenance.artifactDigest, producerUrl: provenance.runUrl };
  const definitions = nsisDefinitions(fs.readFileSync(definitionsFile, "utf8"));
  stage = "embedded offline WebView2 payload";
  const signature = await psJson(`$s=Get-AuthenticodeSignature -LiteralPath ${psQuote(definitions.WEBVIEW2INSTALLERPATH)}; [pscustomobject]@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint}`);
  assert.equal(signature.status, "Valid", "WebView2 build input must have a valid Authenticode signature");
  assert.match(signature.subject || "", /Microsoft Corporation/i);
  const beforeVersion = await psJson(`$keys=@('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'); @($keys | ForEach-Object { (Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue).pv } | Where-Object {$_})`);
  report.webView2PreexistingVersions = beforeVersion ? (Array.isArray(beforeVersion) ? beforeVersion : [beforeVersion]) : [];
  await command(sevenZip, ["t", installer]);
  await command(sevenZip, ["x", installer, `-o${extractRoot}`, "-y"], 120_000);
  const extracted = filesUnder(extractRoot);
  const webViewPayloads = extracted.filter((file) => path.basename(file).toLowerCase() === "microsoftedgewebview2runtimeinstaller.exe");
  assert.equal(webViewPayloads.length, 1, "Final NSIS must contain exactly one complete standalone WebView2 payload");
  assert.equal(fileSha256(webViewPayloads[0]), fileSha256(definitions.WEBVIEW2INSTALLERPATH), "NSIS WebView2 payload differs from its verified build input");
  report.installer = { file: path.basename(installer), sha256: fileSha256(installer), webView2Mode: definitions.INSTALLWEBVIEW2MODE, webView2Sha256: fileSha256(webViewPayloads[0]), webView2Bytes: fs.statSync(webViewPayloads[0]).size, webView2Signer: signature.subject, webView2SignerThumbprint: signature.thumbprint };
  fs.copyFileSync(definitionsFile, path.join(reportDirectory, "installer.nsi"));
  report.checks.push("Final ordinary NSIS embeds the exact Microsoft-signed standalone WebView2 installer selected by offlineInstaller mode");

  stage = "disposable NSIS installation";
  assert.ok(!installation.includes('"') && !/[\r\n\0]/.test(installation));
  await installerCommand(installer, ["/S", "/NS", `/D=${installation}`], 10 * 60_000);
  installed = true;
  const hostExecutable = path.join(installation, `${definitions.MAINBINARYNAME}.exe`);
  runtime = path.join(installation, "runtime");
  assert.ok(fs.statSync(hostExecutable).isFile());
  assert.equal(fileSha256(hostExecutable), fileSha256(definitions.MAINBINARYSRCPATH), "Installed Host differs from its release build input");
  const manifest = assertRuntimeManifest(runtime);
  verifyCodexRuntime(path.join(runtime, "backend/vendor/codex/win-x64"), "x64");
  assert.ok(fs.statSync(path.join(runtime, "backend/dist/auth/desktopBootstrapCredential.js")).isFile());
  assert.ok(fs.statSync(path.join(runtime, "frontend/index.html")).isFile());
  report.nodeVersion = manifest.nodeVersion;
  gitRuntime = verifyGitRuntime(path.join(runtime, "git"), "win32", "x64");
  assertGitManifestFields(manifest, gitRuntime);
  report.gitRuntime = { executable: gitRuntime.executableRelative, manifestSha256: fileSha256(path.join(runtime, "git/crownforge-git-runtime.json")), version: gitRuntime.manifest.gitVersion };
  const identity = JSON.parse(await command(path.join(runtime, "node/node.exe"), ["-p", "JSON.stringify({version:process.versions.node,lts:process.release.lts,arch:process.arch,platform:process.platform})"]));
  assert.equal(identity.version, manifest.nodeVersion); assert.ok(identity.lts); assert.equal(identity.arch, "x64"); assert.equal(identity.platform, "win32");
  report.packagedNodeIdentity = identity;
  report.checks.push("NSIS installs into its owned RUNNER_TEMP directory with verified Node, Rust Core, backend, frontend and complete accepted SDK resources");

  stage = "installed release PE dependency closure";
  const dumpbin = (await ps(`$vswhere=Join-Path \${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'; $vs=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath; if($LASTEXITCODE -ne 0 -or -not $vs){throw 'MSVC tools missing'}; $toolset=Get-ChildItem (Join-Path $vs 'VC\\Tools\\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1; Join-Path $toolset.FullName 'bin\\Hostx64\\x64\\dumpbin.exe'`)).trim();
  const gitCore = path.join(gitRuntime.directory, "ucrt64/bin/git.exe"), gitShell = path.join(gitRuntime.directory, "usr/bin/sh.exe"), gitHttp = path.join(gitRuntime.directory, "ucrt64/libexec/git-core/git-remote-http.exe");
  for (const binary of [gitCore, gitShell, gitHttp]) assert.ok(fs.statSync(binary).isFile(), "Pinned MinGit layout is incomplete");
  const gitBinaries = new Set([gitRuntime.executable, gitCore, gitShell, gitHttp]);
  const binaries = [hostExecutable, path.join(runtime, "node/node.exe"), path.join(runtime, "binaries/crownforge-ide-core.exe"), ...gitBinaries,
    ...filesUnder(path.join(runtime, "backend/vendor/codex/win-x64")).filter((file) => /\.exe$/i.test(file))];
  const dependencies = [];
  for (const binary of binaries) {
    assert.equal(peMachine(binary), 0x8664, `Installed executable has the wrong architecture: ${path.relative(installation, binary)}`);
    const output = await command(dumpbin, ["/DEPENDENTS", binary]);
    const searchPaths = gitBinaries.has(binary) ? minGitDllDirectories(binary, gitRuntime.directory) : [path.dirname(binary)];
    const dlls = new Map();
    for (const directory of searchPaths) for (const name of fs.readdirSync(directory).filter((entry) => /\.dll$/i.test(entry))) {
      const file = path.join(directory, name); assert.ok(fs.lstatSync(file).isFile());
      if (!dlls.has(name.toLowerCase())) dlls.set(name.toLowerCase(), file);
    }
    const imports = dumpbinDependencies(output).map((name) => ({ name, resolution: classifyDependency(name, new Set(dlls.keys())), ...(dlls.has(name.toLowerCase()) ? { packagedPath: path.relative(installation, dlls.get(name.toLowerCase())).replaceAll("\\", "/") } : {}) }));
    dependencies.push({ binary: path.relative(installation, binary).replaceAll("\\", "/"), sha256: fileSha256(binary), imports });
  }
  fs.writeFileSync(path.join(reportDirectory, "release-pe-dependencies.json"), `${JSON.stringify({ sourceCommit: process.env.GITHUB_SHA, sdkProducer: SDK_PRODUCER, binaries: dependencies }, null, 2)}\n`);
  report.checks.push("Installed release Host/Core/Node/SDK and MinGit launcher/core/shell/HTTP helper have x64 PE evidence and explicit OS or verified loader-directory DLL resolution");

  stage = "packaged backend cold start without a model service";
  const data = prepareData("backend-profile");
  const gitOptions = { cwd: data.workspace, env: fixtureEnvironment(data.data) };
  await command(gitRuntime.executable, ["init", "--quiet"], 15_000, gitOptions);
  await command(gitRuntime.executable, ["add", "--", "package.txt"], 15_000, gitOptions);
  await command(gitRuntime.executable, ["-c", "user.name=Package Fixture", "-c", "user.email=package-fixture@example.invalid", "commit", "--quiet", "-m", "Own package fixture"], 15_000, gitOptions);
  fs.appendFileSync(path.join(data.workspace, "package.txt"), "Bundled Git diff fixture\n");
  assert.match(await command(gitRuntime.executable, ["diff", "--", "package.txt"], 15_000, gitOptions), /Bundled Git diff fixture/);
  assert.equal((await command(gitShell, ["-c", "printf 'OWN_MIN_GIT_INTERNAL_SHELL'"], 15_000, gitOptions)).trim(), "OWN_MIN_GIT_INTERNAL_SHELL");
  let gitHttpRequests = 0;
  const gitReceiver = http.createServer((_request, response) => { gitHttpRequests++; response.writeHead(404); response.end("owned disposable Git receiver"); });
  try {
    await new Promise((resolve, reject) => { gitReceiver.once("error", reject); gitReceiver.listen(0, "127.0.0.1", resolve); });
    await assert.rejects(installerCommand(gitRuntime.executable, ["-c", "http.proxy=", "-c", "credential.helper=", "ls-remote", `http://127.0.0.1:${gitReceiver.address().port}/missing.git`], 30_000, gitOptions), (error) => error.code === 128);
    assert.ok(gitHttpRequests > 0, "MinGit HTTP helper must actually load and reach its owned loopback receiver");
  } finally { gitReceiver.closeAllConnections(); await new Promise((resolve) => gitReceiver.close(resolve)); }
  report.gitRuntime.internalShellVerified = true; report.gitRuntime.httpHelperReceiverRequests = gitHttpRequests;
  const node = path.join(runtime, "node/node.exe"), core = path.join(runtime, "binaries/crownforge-ide-core.exe");
  bootstrapToken = crypto.randomBytes(32).toString("hex");
  const backendStartedAt = Date.now();
  child = spawn(node, [path.join(runtime, "bootstrap.cjs")], {
    cwd: data.data, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...fixtureEnvironment(data.data), CREWFORGE_DESKTOP: "1", CROWNFORGE_DESKTOP_RUNTIME: "tauri", CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
      CROWNFORGE_BACKEND_BOOTSTRAP: path.join(runtime, "backend/bootstrap.cjs"), CROWNFORGE_IDE_CORE_EXECUTABLE: core,
      HOST: "127.0.0.1", PORT: "0", USERS_CONFIG: data.users, WORKSPACE_DIR: data.workspace, APP_SETTINGS_CONFIG: path.join(data.data, "app-settings.json"), TEAM_STORE_ROOT: data.data, PLUGINS_DIR: data.plugins, STATIC_DIR: path.join(runtime, "frontend") },
  });
  rememberRoot(child, node, backendStartedAt);
  childClosed = once(child, "close"); void childClosed.catch(() => {});
  child.stderr.on("data", (chunk) => { backendLog = (backendLog + chunk).slice(-8192); });
  lines = readline.createInterface({ input: child.stdout });
  const readyBackend = new Promise((resolve, reject) => {
    lines.on("line", (line) => { try { const frame = JSON.parse(line); if (frame.type === "ready") resolve(frame.url); else if (frame.type === "error") reject(new Error(`Packaged startup failed: ${frame.phase || "unknown"}`)); } catch { reject(new Error("Invalid host protocol frame")); } });
    child.once("error", reject); child.once("close", () => reject(new Error("Packaged backend exited before readiness")));
  });
  void readyBackend.catch(() => {});
  await matchingOwnedProcesses();
  const base = await bounded(readyBackend);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${base}/api/auth/me`, { signal: AbortSignal.timeout(5000) })).status, 401);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { "X-CrownForge-Desktop-Bootstrap": "wrong-fixture-credential" }, signal: AbortSignal.timeout(5000) })).status, 401);
  const response = await fetch(`${base}/api/auth/me`, { headers: { "X-CrownForge-Desktop-Bootstrap": bootstrapToken }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); const me = await response.json(); assert.equal(me.desktop, true); assert.equal(typeof me.token, "string"); bearer = me.token;
  async function api(route) {
    const value = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10_000) });
    assert.equal(value.status, 200, `Packaged route failed: ${route}`); return value.json();
  }
  assert.equal((await api("/api/health")).status, "ok");
  assert.ok((await api("/api/files/tree")).some((entry) => entry.name === "package.txt"));
  assert.match((await api("/api/files/read?path=package.txt")).content, /UTF-8 中文/);
  assert.ok((await api("/api/files/search?query=Windows&useIgnoreFiles=false")).results.some((entry) => entry.path === "package.txt"));
  const gitStatus = await api("/api/files/git-status"); assert.equal(gitStatus.isRepo, true); assert.ok(gitStatus.entries.some((entry) => entry.path === "package.txt"));
  const page = await fetch(base, { signal: AbortSignal.timeout(5000) }); assert.equal(page.status, 200); assert.match(await page.text(), /id="root"/);
  const native = (await processSnapshot(child.pid)).filter((entry) => entry.Name.toLowerCase() === "crownforge-ide-core.exe");
  assert.equal(native.length, 1, "Installed backend must start the installed native service");
  assert.equal(path.resolve(native[0].ExecutablePath).toLowerCase(), path.resolve(core).toLowerCase());
  report.checks.push("Installed backend starts with empty user settings and no running model, serves installed frontend, requires private bootstrap and executes installed Rust file/search services");
  report.checks.push("Verified installed Git performs init/commit/diff and the native Git status API works with runner Git removed from PATH");

  stage = "installed native PowerShell terminal";
  const require = createRequire(path.join(runtime, "backend/package.json"));
  const { WebSocket } = require("ws");
  socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws/terminal?protocol=2&token=${encodeURIComponent(bearer)}`);
  const frames = []; let frameError; let cursor = ""; let cursorReplies = 0; let output = "";
  socket.on("error", () => { frameError = new Error("Installed terminal transport failed"); });
  socket.on("message", (bytes) => {
    try {
      const frame = JSON.parse(bytes.toString()); assert.equal(typeof frame.type, "string");
      frames.push(frame); assert.ok(frames.length <= 5000);
      if (frame.type === "output") {
        output = (output + frame.data).slice(-262144); cursor += frame.data;
        for (const _match of cursor.matchAll(/\x1b\[6n/g)) { socket.send(JSON.stringify({ type: "input", data: "\x1b[1;1R" })); cursorReplies++; }
        cursor = cursor.replace(/\x1b\[6n/g, "").slice(-8);
      }
    } catch { frameError = new Error("Invalid installed terminal frame"); }
  });
  await bounded(once(socket, "open"));
  socket.send(JSON.stringify({ type: "attach", clientKey: crypto.randomUUID(), documentId: crypto.randomUUID() }));
  async function waitFrame(predicate, milliseconds = 60_000) {
    let timer;
    try { return await bounded(new Promise((resolve, reject) => { timer = setInterval(() => { if (frameError) reject(frameError); else { const frame = frames.find(predicate); if (frame) resolve(frame); } }, 20); }), milliseconds); }
    finally { clearInterval(timer); }
  }
  const ready = await waitFrame((frame) => frame.type === "ready");
  socket.send(JSON.stringify({ type: "ready_ack", ticket: ready.ticket }));
  const plainOutput = () => output.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  await waitFrame(() => /PS [\s\S]*>\s*$/.test(plainOutput()));
  socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  const marker = `PKG_${crypto.randomUUID().replaceAll("-", "")}_中文`;
  const split = Math.floor(marker.length / 2);
  socket.send(JSON.stringify({ type: "input", data: `Write-Output ('${marker.slice(0, split)}' + '${marker.slice(split)}')\r` }));
  await waitFrame(() => output.includes(marker));
  await processSnapshot(child.pid);
  socket.send(JSON.stringify({ type: "stop" })); await waitFrame((frame) => frame.type === "exit");
  socket.close(); await bounded(once(socket, "close"), 5000); socket = undefined;
  report.cursorReplies = cursorReplies;
  report.checks.push("Installed Node/Core provide a real PowerShell prompt, split-marker UTF-8 execution and terminal stop without Bash or node-pty");
  stage = "installed backend shutdown";
  child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
  const [exitCode] = await bounded(childClosed, 25_000); assert.equal(exitCode, 0);
  assert.throws(() => process.kill(native[0].ProcessId, 0), { code: "ESRCH" }, "Owned installed Core must exit with the backend");
  report.checks.push("Private shutdown exits installed backend with code zero and no remaining installed Core");

  stage = "installed Tauri Host launch";
  const hostData = prepareData("host-profile");
  const hostStartedAt = Date.now();
  host = spawn(hostExecutable, [], { cwd: hostData.data, env: fixtureEnvironment(hostData.data), stdio: ["ignore", "ignore", "pipe"] });
  rememberRoot(host, hostExecutable, hostStartedAt);
  hostClosed = once(host, "close"); void hostClosed.catch(() => {});
  host.stderr.on("data", (chunk) => { backendLog = (backendLog + chunk).slice(-8192); });
  await matchingOwnedProcesses();
  const hostDeadline = Date.now() + 60_000; let hostState;
  while (Date.now() < hostDeadline) {
    assert.equal(host.exitCode, null, "Installed Host exited before its window and backend became ready");
    hostState = await psJson(`$p=Get-Process -Id ${host.pid} -ErrorAction Stop; $p.Refresh(); $nodes=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${host.pid}' | Where-Object {$_.Name -eq 'node.exe'}); [pscustomobject]@{window=$p.MainWindowHandle.ToInt64();nodes=@($nodes | Select-Object ProcessId,ExecutablePath);listeners=@($nodes | ForEach-Object { Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue } | Select-Object LocalAddress,LocalPort)}`);
    if (hostState.window && hostState.nodes.length === 1 && hostState.listeners.some((entry) => entry.LocalAddress === "127.0.0.1")) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(hostState?.window, "Installed Host must create a real Windows window on this VM");
  assert.equal(hostState.nodes.length, 1);
  assert.equal(path.resolve(hostState.nodes[0].ExecutablePath).toLowerCase(), path.resolve(node).toLowerCase(), "Host must use its bundled Node");
  const listener = hostState.listeners.find((entry) => entry.LocalAddress === "127.0.0.1"); assert.ok(listener);
  assert.equal((await fetch(`http://127.0.0.1:${listener.LocalPort}/api/auth/me`, { signal: AbortSignal.timeout(5000) })).status, 401);
  report.hostWindowCreated = true;
  await processSnapshot(host.pid);
  report.checks.push("Installed Tauri Host creates a Windows window and starts its bundled Node on loopback with a private bootstrap boundary; no visual or missing-WebView2 claim");
  stage = "installed Host shutdown";
  const closed = await psJson(`$p=Get-Process -Id ${host.pid} -ErrorAction Stop; [pscustomobject]@{closed=$p.CloseMainWindow()}`);
  assert.equal(closed.closed, true);
  const [hostCode] = await bounded(hostClosed, 30_000); assert.equal(hostCode, 0);
  assert.throws(() => process.kill(hostState.nodes[0].ProcessId, 0), { code: "ESRCH" }, "Host must stop its owned Node daemon");
  report.checks.push("Closing the actual installed Host window exits zero and removes its owned backend");
  report.status = "passed";
} catch (error) {
  report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
} finally {
  socket?.terminate(); lines?.close();
  const failures = await runCleanupSteps([
    ["backend shutdown", async () => {
      if (child?.exitCode === null && child.signalCode === null) {
        if (!child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
        try { await bounded(childClosed, 25_000); } catch { await forceOwnedTree(child); await bounded(childClosed, 5000); }
      }
    }],
    ["Host shutdown", async () => {
      if (host?.exitCode === null && host.signalCode === null) { await forceOwnedTree(host); await bounded(hostClosed, 5000); }
    }],
    ["installer shutdown", async () => {
      for (const processChild of installerChildren) if (processChild.exitCode === null && processChild.signalCode === null) await forceOwnedTree(processChild);
    }],
    ["owned descendant cleanup", async () => {
      let remaining = await matchingOwnedProcesses();
      if (report.status === "passed") {
        const deadline = Date.now() + 10_000;
        while (remaining.length && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 200)); remaining = await matchingOwnedProcesses(); }
        if (remaining.length) { report.status = "failed"; process.exitCode = 1; report.cleanupFailure = "Normal package shutdown left owned descendants alive"; }
      }
      report.forcedCleanupProcessCount = remaining.length;
      const processFailures = await runCleanupSteps(remaining.map((entry) => [`owned PID ${entry.ProcessId}`, async () => {
        if (!(await matchingOwnedProcesses()).some((current) => current.ProcessId === entry.ProcessId)) return;
        try { await command(taskkill, ["/PID", String(entry.ProcessId), "/T", "/F"], 10_000); }
        catch { assert.ok(!(await matchingOwnedProcesses()).some((current) => current.ProcessId === entry.ProcessId), "Owned process-tree cleanup failed"); }
      }]));
      assert.deepEqual(processFailures, []);
      assert.equal((await matchingOwnedProcesses()).length, 0, "Owned package processes must be gone before fixture deletion");
      report.ownedProcessesRemaining = 0;
    }],
    ["disposable App uninstall", async () => {
      assert.equal((await matchingOwnedProcesses()).length, 0, "Live owned processes prevent uninstall");
      if (installed || fs.existsSync(path.join(installation, "uninstall.exe"))) {
        const uninstaller = path.join(installation, "uninstall.exe");
        assert.ok(fs.existsSync(uninstaller), "Installed package uninstaller is required");
        // _?= keeps this owned uninstaller in-place instead of spawning an
        // untracked temporary self-copy. It is the final NSIS argument.
        await installerCommand(uninstaller, ["/S", `_?=${installation}`], 120_000);
        report.disposableAppUninstalled = true;
      }
    }],
    ["fixture deletion", async () => {
      assert.equal((await matchingOwnedProcesses()).length, 0, "Live owned processes prevent fixture deletion");
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }],
  ]);
  if (failures.length) { report.status = "failed"; process.exitCode = 1; report.cleanupFailures = failures; }
  if (report.failure && backendLog) fs.writeFileSync(path.join(reportDirectory, "package-failure.log"), backendLog.replaceAll(bootstrapToken || "unused-bootstrap", "[redacted]").replaceAll(bearer || "unused-bearer", "[redacted]"));
  fs.writeFileSync(path.join(reportDirectory, "package-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, checks: report.checks, ...(report.failure ? { failure: report.failure } : {}), ...(report.cleanupFailure ? { cleanupFailure: report.cleanupFailure } : {}) }));
}
