import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "CROWNFORGE_NETWORK_MATRIX:";
const PROBE_MS = 90_000;
const OFFICIAL_KEYS = [
  "9f5f3812-79f0-4fe9-9615-4c2c92d2f0ff", "87498484-45ab-4510-845e-ece8b791b3bc",
  "af4751de-f874-4a7b-a34d-f0d0f22d1d9b", "ea10db66-a928-4b2e-a82e-a376a54f93ba",
  "83172805-f6be-4ae1-9dc6-6847aef04e7f", "d23b2efb-1efb-46b2-96f3-b0ccda5690c8",
  "420b026f-9dc9-4aea-88f4-0f2b9feab39a", "8d917c81-99cc-45e7-84d6-824df860cfb8",
  "e1d6e0af-ce5f-471b-b2d3-15ca00e966f3", "c2bceca4-66ef-4a0f-ba80-f4f761b8c6f0",
  "ba10c618-84e7-4b83-8f74-36e22b2fa1ff", "fe7f22b8-5cf5-4adb-b2aa-71fc0a8f5d44",
];
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ps = (value) => "'" + String(value).replaceAll("'", "''") + "'";

export function parseProbeOutput(output) {
  if (typeof output !== "string") return { errorKind: "protocol" };
  if (/^Error: Timeout/.test(output)) return { errorKind: "timeout" };
  if (/^Error: Stopped/.test(output)) return { errorKind: "cancelled" };
  const exit = output.match(/^Error: Process exited with code (-?\d+)/);
  if (exit) return { errorKind: "exit", exitCode: Number(exit[1]) };
  if (/^Error:/.test(output)) return { errorKind: "launcher" };
  const records = output.split(/\r?\n/).filter((line) => line.startsWith(PREFIX));
  if (records.length !== 1) return { errorKind: "protocol" };
  try {
    const value = JSON.parse(records[0].slice(PREFIX.length));
    if (value.completed !== true || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      !/^S-1-\d+(?:-\d+)+$/.test(value.sid) || typeof value.ack !== "boolean" ||
      typeof value.sent !== "boolean" || ![null, 10013, 10060, 10061, 10051, 10065].includes(value.socketError) ||
      ![null, false, true].includes(value.privateReadable) || ![null, false, true].includes(value.writeAllowed)) {
      return { errorKind: "protocol" };
    }
    return { errorKind: null, exitCode: 0, ...value };
  } catch { return { errorKind: "protocol" }; }
}

export function classifyNetworkProbe(execution, received, expected, acceptedConnections = 0) {
  if (execution.errorKind) return "EXECUTION_ERROR";
  if (!Number.isSafeInteger(received) || received < 0) return "INVALID_RECEIVER";
  if (expected === "deny") {
    if (received > 0 || execution.ack || acceptedConnections > 0) return "NETWORK_LEAK";
    // A completed socket probe must report a factual socket rejection/timeout.
    // Missing output, failed PowerShell and launch deadlines cannot establish denial.
    return execution.socketError !== null ? "DENIED" : "UNCONFIRMED";
  }
  return execution.ack && execution.sent && received === 1 && execution.socketError === null ? "CONNECTED" : "CONNECT_FAILED";
}

export function probeSource(endpoint, nonce, privateFile, writeFile) {
  assert.ok(["tcp", "udp"].includes(endpoint.protocol));
  assert.ok(["127.0.0.1", "::1"].includes(endpoint.host));
  assert.ok(Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port < 65536);
  assert.match(nonce, /^[a-f0-9]{64}$/);
  const family = endpoint.host === "::1" ? "InterNetworkV6" : "InterNetwork";
  const socket = endpoint.protocol === "tcp" ? [
    "$client = [Net.Sockets.TcpClient]::new([Net.Sockets.AddressFamily]::" + family + ")",
    "$task = $client.ConnectAsync([Net.IPAddress]::Parse(" + ps(endpoint.host) + "), " + endpoint.port + ")",
    "if (-not $task.Wait(3000)) { $socketError = 10060 } else {",
    "  $stream = $client.GetStream(); $stream.ReadTimeout = 3000; $stream.WriteTimeout = 3000",
    "  $stream.Write($bytes, 0, $bytes.Length); $sent = $true; $ack = ($stream.ReadByte() -eq 65)",
    "  if (-not $ack) { throw [InvalidOperationException]::new('Unexpected fixture acknowledgement') }",
    "}",
  ] : [
    "$client = [Net.Sockets.UdpClient]::new([Net.Sockets.AddressFamily]::" + family + ")",
    "$client.Client.ReceiveTimeout = 3000; $client.Client.SendTimeout = 3000",
    "$client.Connect([Net.IPAddress]::Parse(" + ps(endpoint.host) + "), " + endpoint.port + ")",
    "$sent = ($client.Send($bytes, $bytes.Length) -eq $bytes.Length)",
    "$remote = [Net.IPEndPoint]::new([Net.IPAddress]::" + (endpoint.host === "::1" ? "IPv6Any" : "Any") + ", 0)",
    "$reply = $client.Receive([ref]$remote); $ack = ($reply.Length -eq 1 -and $reply[0] -eq 65)",
    "if (-not $ack) { throw [InvalidOperationException]::new('Unexpected fixture acknowledgement') }",
  ];
  const fileChecks = privateFile && writeFile ? [
    "$privateReadable = $false; $writeAllowed = $false",
    "try { $null = [IO.File]::ReadAllText(" + ps(privateFile) + "); $privateReadable = $true } catch {",
    "  $err = $_.Exception; while ($err.InnerException) { $err = $err.InnerException }",
    "  if (-not ($err -is [UnauthorizedAccessException]) -and -not ($err -is [Security.SecurityException])) { throw }",
    "}",
    "try { [IO.File]::WriteAllText(" + ps(writeFile) + ", 'fixture-write'); $writeAllowed = $true } catch {",
    "  $err = $_.Exception; while ($err.InnerException) { $err = $err.InnerException }",
    "  if (-not ($err -is [UnauthorizedAccessException]) -and -not ($err -is [Security.SecurityException])) { throw }",
    "}",
  ] : ["$privateReadable = $null; $writeAllowed = $null"];
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $sid = $identity.User.Value; $identity.Dispose()",
    "$bytes = [Text.Encoding]::ASCII.GetBytes(" + ps(nonce) + ")",
    "$sent = $false; $ack = $false; $socketError = $null; $client = $null",
    "try {", ...socket, "} catch {",
    "  $err = $_.Exception; while ($err.InnerException) { $err = $err.InnerException }",
    "  if ($err -is [Net.Sockets.SocketException]) { $socketError = $err.NativeErrorCode } else { throw }",
    "} finally { if ($client) { $client.Dispose() } }",
    ...fileChecks,
    "$socketJson = if ($null -eq $socketError) { 'null' } else { [string]$socketError }",
    "$readJson = if ($null -eq $privateReadable) { 'null' } else { $privateReadable.ToString().ToLowerInvariant() }",
    "$writeJson = if ($null -eq $writeAllowed) { 'null' } else { $writeAllowed.ToString().ToLowerInvariant() }",
    "[Console]::WriteLine('" + PREFIX + '{"completed":true,"pid":' + "' + $PID + '," +
      '"sid":"' + "' + $sid + '" + '","ack":' + "' + $ack.ToString().ToLowerInvariant() + '," +
      '"sent":' + "' + $sent.ToString().ToLowerInvariant() + '," + '"socketError":' + "' + $socketJson + '," +
      '"privateReadable":' + "' + $readJson + '," + '"writeAllowed":' + "' + $writeJson + '}')",
  ].join("\n");
}

export async function fixtureReceiver(protocol, host) {
  const counts = new Map();
  const sockets = new Set();
  let connections = 0;
  const record = (bytes) => {
    const nonce = bytes.toString("ascii");
    if (!counts.has(nonce)) return false;
    counts.set(nonce, counts.get(nonce) + 1); return true;
  };
  const server = protocol === "tcp" ? net.createServer((socket) => {
    connections += 1; sockets.add(socket);
    socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 64) {
        if (bytes.length === 64 && record(bytes)) socket.end(Buffer.from("A"));
        else socket.destroy();
      }
    });
  }) : dgram.createSocket(host === "::1" ? "udp6" : "udp4");
  if (protocol === "udp") server.on("message", (bytes, remote) => {
    if (record(bytes)) server.send(Buffer.from("A"), remote.port, remote.address, () => {});
  });
  server.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Receiver startup deadline")), 5000);
      const finish = (error) => { clearTimeout(timeout); server.removeListener("error", failed); error ? reject(error) : resolve(); };
      const failed = (error) => finish(error); server.once("error", failed);
      if (protocol === "tcp") server.listen({ port: 0, host, ipv6Only: host === "::1" }, () => finish());
      else server.bind({ port: 0, address: host, ipv6Only: host === "::1" }, () => finish());
    });
  } catch (error) { try { server.close(); } catch {} throw error; }
  return {
    endpoint: { protocol, host, port: server.address().port },
    expect(nonce) { counts.set(nonce, 0); },
    count(nonce) { return counts.get(nonce) ?? 0; },
    connections() { return connections; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
  };
}

export async function hostProbe(receiver, nonce) {
  receiver.expect(nonce);
  const endpoint = receiver.endpoint;
  return new Promise((resolve) => {
    const socket = endpoint.protocol === "tcp" ? net.createConnection(endpoint.port, endpoint.host) : dgram.createSocket(endpoint.host === "::1" ? "udp6" : "udp4");
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timeout); endpoint.protocol === "tcp" ? socket.destroy() : socket.close(); resolve(ok); };
    const timeout = setTimeout(() => finish(false), 5000);
    socket.on("error", () => finish(false));
    if (endpoint.protocol === "tcp") {
      socket.once("connect", () => socket.write(nonce));
      socket.once("data", (bytes) => finish(bytes.length === 1 && bytes[0] === 65));
    } else {
      socket.once("message", (bytes) => finish(bytes.length === 1 && bytes[0] === 65));
      socket.send(Buffer.from(nonce), endpoint.port, endpoint.host, (error) => { if (error) finish(false); });
    }
  });
}

async function deadline(action, timeoutMs) {
  let timeout;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
    timeout = setTimeout(() => { const error = new Error("Deadline"); error.code = "MATRIX_TIMEOUT"; reject(error); }, timeoutMs);
  })]); }
  finally { clearTimeout(timeout); }
}

export async function main() {
  const reportPath = path.join(repo, ".artifacts/app-rust-sandbox/network-matrix-report.json");
  const report = { schemaVersion: 1, status: "MATRIX_ERROR", sourceCommit: process.env.GITHUB_SHA ?? null,
    startedAt: new Date().toISOString(), platform: process.platform, checks: [], probes: [], modelRequests: 0,
    fullNetworkMatrixAcceptance: false, fullSandboxAcceptance: false, agentPidCleanupAcceptance: false };
  const previous = new Map(); const receivers = []; const children = new Set(); const clients = new Set();
  let root; let powershell; let phase = "CI authorization"; let failure = false;
  const setEnv = (key, value) => { if (!previous.has(key)) previous.set(key, process.env[key]); value === undefined ? delete process.env[key] : process.env[key] = value; };
  const save = () => { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n"); };
  const check = (name, condition, metadata = {}) => {
    report.checks.push({ name, status: condition ? "PASS" : "FAIL", ...metadata }); if (!condition) failure = true; save();
  };
  const hostPS = (source, timeout = 30_000) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
    env.PSModulePath = path.join(path.dirname(powershell), "Modules");
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; " + source],
    { env, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 512_000 });
    if (result.error || result.status !== 0) throw new Error("Trusted fixture operation failed");
    return result.stdout.trim();
  };
  const controlledEnv = (home) => {
    const keys = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "PATHEXT", "TEMP", "TMP", "PATH"]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.has(key.toUpperCase())).map(([key, value]) => [key.toUpperCase(), value]));
    env.CODEX_HOME = home; env.PSMODULEPATH = path.join(path.dirname(powershell), "Modules"); return env;
  };
  const launch = (executable, args, options) => {
    const child = spawn(executable, args, options); children.add(child); child.once("close", () => children.delete(child)); return child;
  };
  const rawOfficial = async (executable, args, home, cwd) => {
    const child = launch(executable, args, { cwd, env: controlledEnv(home), windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let overflow = false; let timedOut = false; let spawnError = false;
    child.stdout.on("data", (bytes) => { if (Buffer.byteLength(output) + bytes.length > 16384) { overflow = true; child.kill(); } else output += bytes.toString("utf8"); });
    child.stderr.on("data", () => {}); child.on("error", () => { spawnError = true; });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, PROBE_MS);
    const forced = setTimeout(() => { if (child.pid) spawnSync(path.join(process.env.SystemRoot, "System32/taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, stdio: "ignore" }); }, PROBE_MS + 1000);
    try {
      const code = await deadline(() => new Promise((resolve) => child.once("close", resolve)), PROBE_MS + 15_000);
      if (timedOut) return { errorKind: "timeout" };
      if (spawnError || overflow) return { errorKind: "launcher" };
      if (code !== 0) return { errorKind: "exit", exitCode: code };
      return parseProbeOutput(output);
    } finally { clearTimeout(timeout); clearTimeout(forced); }
  };
  const snapshot = (label) => {
    const file = path.join(root, "wfp-" + label + ".xml");
    const result = spawnSync(path.join(process.env.SystemRoot, "System32/netsh.exe"), ["wfp", "show", "filters", "file=" + file], { windowsHide: true, timeout: 30_000, stdio: "ignore" });
    assert.equal(result.status, 0, "WFP snapshot must complete");
    const source = [
      "$xml = [Xml.XmlDocument]::new(); $xml.Load(" + ps(file) + ")",
      "$keys = @(" + OFFICIAL_KEYS.map(ps).join(",") + "); $filters = @(); $sha = [Security.Cryptography.SHA256]::Create()",
      "foreach ($key in $keys) {",
      "  $nodes = @($xml.SelectNodes(\"//*[local-name()='filterKey']\") | Where-Object { $_.InnerText.Trim('{}').ToLowerInvariant() -eq $key })",
      "  $hash = $null; if ($nodes.Count -eq 1) { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($nodes[0].ParentNode.OuterXml)))).Replace('-', '').ToLowerInvariant() }",
      "  $filters += [ordered]@{ key = $key; count = $nodes.Count; hash = $hash }",
      "}",
      "$accounts = @(); foreach ($name in @('CodexSandboxOffline','CodexSandboxOnline')) {",
      "  $sid = [Security.Principal.NTAccount]::new($env:COMPUTERNAME, $name).Translate([Security.Principal.SecurityIdentifier]).Value",
      "  $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid)))).Replace('-', '').ToLowerInvariant()",
      "  $accounts += [ordered]@{ role = $name; sidHash = $hash }",
      "}",
      "$sha.Dispose(); [ordered]@{ accounts = $accounts; filters = $filters } | ConvertTo-Json -Depth 5 -Compress",
    ].join("\n");
    try { return JSON.parse(hostPS(source)); } finally { fs.rmSync(file, { force: true }); }
  };
  try {
    assert.equal(process.platform, "win32", "Real Windows is required");
    assert.equal(process.env.GITHUB_ACTIONS, "true", "Only disposable GitHub Actions runners are authorized");
    assert.deepEqual(process.argv.slice(2), ["--allow-setup"], "Explicit CI sandbox setup authorization is required");
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    assert.ok(systemRoot && /^[A-Za-z]:[\\/]/.test(systemRoot) && !systemRoot.includes("\0"));
    powershell = fs.realpathSync.native(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"));
    assert.equal(hostPS("[Console]::WriteLine(([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"), "True");
    check("real Windows CI administrator with explicit setup", true);
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-network-matrix-")));
    const workspace = path.join(root, "workspace"); const settings = path.join(root, "settings"); const plugins = path.join(root, "plugins");
    for (const directory of [workspace, settings, plugins]) fs.mkdirSync(directory);
    const privateFile = path.join(workspace, ".env"); fs.writeFileSync(privateFile, crypto.randomBytes(32).toString("hex"));
    const users = path.join(settings, "users.json"); const appSettings = path.join(settings, "app-settings.json");
    fs.writeFileSync(users, JSON.stringify({ allowedRoots: [workspace], users: [] })); fs.writeFileSync(appSettings, "{}\n");
    fs.writeFileSync(path.join(settings, "agent-execution.json"), JSON.stringify({ environment: "native", sandboxMode: "elevated" }));
    for (const key of Object.keys(process.env)) if (/^(?:CROWNFORGE_WINDOWS_|CROWNFORGE_WSL_|CODEX_|OPENAI_|ANTHROPIC_)/i.test(key) || ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN"].includes(key)) setEnv(key, undefined);
    for (const [key, value] of Object.entries({ USERS_CONFIG: users, APP_SETTINGS_CONFIG: appSettings, WORKSPACE_DIR: workspace,
      TEAM_STORE_ROOT: path.join(root, "teams"), PLUGINS_DIR: plugins, CREWFORGE_DESKTOP: "1",
      CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT: "native", CROWNFORGE_WINDOWS_SANDBOX_MODE: "elevated",
      VLLM_API_URL: "http://127.0.0.1:9/v1", VLLM_API_KEY: "" })) setEnv(key, value);
    // No backend module is evaluated until all configuration has been isolated.
    const [native, processSandbox, rpc, preparation] = await Promise.all([
      import("../backend/dist/agent/windowsNativeSandbox.js"), import("../backend/dist/agent/processSandbox.js"),
      import("../backend/dist/agent/codexSandboxClient.js"), import("../desktop/scripts/prepare-codex-runtime.mjs"),
    ]);
    const baseline = path.join(repo, ".artifacts/codex-runtime-cache/0.160.0", process.arch, "baseline");
    phase = "verify official baseline"; preparation.verifyOfficialCodexBaseline(baseline, process.arch);
    const officialExe = path.join(baseline, "bin/codex.exe"); const officialHome = path.join(root, "official-home"); fs.mkdirSync(officialHome);
    const base = [
      'default_permissions = "matrix"', "check_for_update_on_startup = false", 'model_provider = "matrix-offline"',
      'approval_policy = "never"', 'web_search = "disabled"', "allow_login_shell = false",
      "[windows]", 'sandbox = "elevated"', "[features]", "prefer_mxc = false",
      "[analytics]", "enabled = false", "[feedback]", "enabled = false",
      "[model_providers.matrix-offline]", 'name = "Execution fixture only"', 'base_url = "http://127.0.0.1:9"',
      'wire_api = "responses"', "requires_openai_auth = false", "[permissions.matrix.filesystem]", '":root" = "read"',
      '":project_roots" = "read"', "[permissions.matrix.network]",
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(officialHome, "config.toml"), base + "enabled = false\n");
    const client = new rpc.CodexSandboxClient({ executable: officialExe,
      args: ["-c", 'windows.sandbox="elevated"', "-c", "features.prefer_mxc=false", "app-server", "--stdio"],
      cwd: officialHome, env: controlledEnv(officialHome), spawn: launch });
    clients.add(client); phase = "official baseline explicit setup"; await client.initialize();
    const completed = client.waitForNotification("windowsSandbox/setupCompleted", 180_000); completed.catch(() => {});
    assert.equal((await client.call("windowsSandbox/setupStart", { mode: "elevated", cwd: workspace })).started, true);
    assert.equal((await deadline(() => completed, 180_000)).success, true);
    assert.equal((await client.call("windowsSandbox/readiness")).status, "ready"); client.close(); clients.delete(client);
    report.officialBefore = snapshot("before"); check("official WFP inventory exists", report.officialBefore.filters.every((entry) => entry.count === 1 && entry.hash));
    fs.writeFileSync(path.join(officialHome, "config.toml"), base + "enabled = true\n");
    let v4tcp;
    for (const host of ["127.0.0.1", "::1"]) for (const protocol of ["tcp", "udp"]) {
      try { const receiver = await fixtureReceiver(protocol, host); receivers.push(receiver); if (host === "127.0.0.1" && protocol === "tcp") v4tcp = receiver; }
      catch { check("fixture receiver " + protocol + " " + host, false, { unavailable: true }); }
    }
    report.fixtureEndpoints = receivers.map((receiver) => receiver.endpoint);
    assert.ok(v4tcp, "Official positive control requires IPv4 fixture listener");
    const probe = async (name, receiver, expected, execute) => {
      phase = name; const nonce = crypto.randomBytes(32).toString("hex"); receiver.expect(nonce); const started = Date.now();
      const connectionsBefore = receiver.connections();
      let execution; try { execution = await execute(nonce); } catch (error) { execution = { errorKind: error?.code === "MATRIX_TIMEOUT" ? "timeout" : "launcher" }; }
      await pause(250);
      const received = receiver.count(nonce); const acceptedConnections = receiver.connections() - connectionsBefore;
      const verdict = classifyNetworkProbe(execution, received, expected, acceptedConnections);
      const metadata = { name, expected, verdict, elapsedMs: Date.now() - started, timeoutMs: PROBE_MS,
        errorKind: execution.errorKind, exitCode: execution.exitCode ?? null, payloadPid: execution.pid ?? null,
        sidHash: execution.sid ? sha(execution.sid) : null, nonceReceipts: received, receiverConnections: receiver.connections(), acceptedConnections,
        socketError: execution.socketError ?? null, privateReadable: execution.privateReadable ?? null, writeAllowed: execution.writeAllowed ?? null };
      report.probes.push(metadata); check(name, verdict === (expected === "deny" ? "DENIED" : "CONNECTED"));
      console.log(JSON.stringify({ probe: name, verdict, elapsedMs: metadata.elapsedMs, errorKind: metadata.errorKind, payloadPid: metadata.payloadPid, nonceReceipts: received, acceptedConnections }));
      return metadata;
    };
    const officialTCP = (name) => probe(name, v4tcp, "inherit", (nonce) => rawOfficial(officialExe,
      ["-c", 'windows.sandbox="elevated"', "-c", "features.prefer_mxc=false", "sandbox", "-P", "matrix", "-C", workspace,
        "--", powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probeSource(v4tcp.endpoint, nonce)],
      officialHome, workspace));
    const beforeControl = await officialTCP("official Online TCP before patched setup");
    check("official before control uses official Online SID", beforeControl.sidHash === report.officialBefore.accounts.find((entry) => entry.role === "CodexSandboxOnline").sidHash);
    phase = "patched explicit setup"; await deadline(() => native.setupWindowsNativeSandbox(workspace, "elevated"), 180_000);
    assert.equal((await native.probeWindowsNativeSandbox()).available, true); check("patched runtime ready after explicit setup", true);
    const filesystem = { workspaceDir: workspace, readPaths: ["."], writePaths: [] };
    for (const receiver of receivers) {
      const label = receiver.endpoint.protocol + " " + receiver.endpoint.host;
      phase = "host positive " + label; const nonce = crypto.randomBytes(32).toString("hex");
      const positive = await hostProbe(receiver, nonce); await pause(100);
      check("host positive " + label, positive && receiver.count(nonce) === 1, { nonceReceipts: receiver.count(nonce) });
      if (!positive || receiver.count(nonce) !== 1) continue;
      for (const networkMode of ["deny", "inherit"]) {
        const writeFile = path.join(workspace, "inherit-write-" + receivers.indexOf(receiver) + ".txt");
        const metadata = await probe("patched " + networkMode + " " + label, receiver, networkMode, async (nonce) => {
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), PROBE_MS);
          try {
            const output = await deadline(() => processSandbox.runWorkspaceProcess({ executable: powershell,
              args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probeSource(receiver.endpoint, nonce,
                networkMode === "inherit" ? privateFile : undefined, networkMode === "inherit" ? writeFile : undefined)],
              cwd: workspace, filesystem, networkMode, signal: controller.signal, limits: { wallTimeMs: PROBE_MS }, maxOutputBytes: 16384 }), PROBE_MS + 15_000);
            return parseProbeOutput(output);
          } finally { clearTimeout(timer); }
        });
        if (networkMode === "inherit") check("inherit retains file boundaries " + label,
          metadata.errorKind === null && metadata.privateReadable === false && metadata.writeAllowed === false && !fs.existsSync(writeFile));
        check("patched " + networkMode + " identity isolated from official " + label,
          metadata.sidHash !== null && report.officialBefore.accounts.every((entry) => entry.sidHash !== metadata.sidHash));
      }
    }
    const afterControl = await officialTCP("official Online TCP after patched execution");
    phase = "official after snapshot"; report.officialAfter = snapshot("after");
    check("official account SIDs and filter keys remain unchanged", JSON.stringify(report.officialBefore) === JSON.stringify(report.officialAfter));
    check("official Online control identity unchanged", afterControl.sidHash === beforeControl.sidHash);
    const offline = report.probes.filter((entry) => entry.name.startsWith("patched deny "));
    const online = report.probes.filter((entry) => entry.name.startsWith("patched inherit "));
    check("four Offline and four inherit combinations executed", offline.length === 4 && online.length === 4);
    check("consistent separate patched Offline and Online identities", offline.length === 4 && online.length === 4 &&
      offline.every((entry) => entry.sidHash && entry.sidHash === offline[0].sidHash) &&
      online.every((entry) => entry.sidHash && entry.sidHash === online[0].sidHash) && offline[0].sidHash !== online[0].sidHash);
    report.fullNetworkMatrixAcceptance = !failure; report.status = failure ? "MATRIX_FAIL" : "MATRIX_PASS";
  } catch (error) {
    failure = true; report.status = "MATRIX_ERROR"; report.failure = { phase,
      errorKind: error?.code === "ERR_ASSERTION" ? "assertion" : error?.code === "MATRIX_TIMEOUT" ? "timeout" : "operation" };
  } finally {
    for (const client of clients) client.close();
    for (const child of children) { try { child.kill(); } catch {} }
    for (const receiver of receivers) { try { await deadline(() => receiver.close(), 5000); } catch { report.receiverCleanupFailed = true; failure = true; } }
    if (children.size) await pause(1000);
    for (const child of children) if (child.pid) spawnSync(path.join(process.env.SystemRoot, "System32/taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { timeout: 10_000, windowsHide: true, stdio: "ignore" });
    if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { report.fixtureCleanupFailed = true; failure = true; } }
    for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value;
    if (failure && report.status === "MATRIX_PASS") { report.status = "MATRIX_FAIL"; report.fullNetworkMatrixAcceptance = false; }
    report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ status: report.status, fullNetworkMatrixAcceptance: report.fullNetworkMatrixAcceptance,
      fullSandboxAcceptance: false, agentPidCleanupAcceptance: false, probes: report.probes.length }));
  }
  return failure ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exit(await main());
