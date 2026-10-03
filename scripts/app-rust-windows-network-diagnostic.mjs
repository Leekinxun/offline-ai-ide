import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(repo, ".artifacts/app-rust-sandbox/network-diagnostic-report.json");
const fixtureId = crypto.randomUUID();
const ruleName = `CrownForge_APP_RUST_Loopback_Diagnostic_${fixtureId}`;
const PROBE_TIMEOUT_MS = 30_000;
const report = {
  schemaVersion: 1, status: "DIAGNOSTIC_ERROR", sourceCommit: process.env.GITHUB_SHA || null,
  startedAt: new Date().toISOString(), fixtureId, platform: process.platform,
  originalDenial: null, allUsersDenial: null, sandboxWhoamiSid: null,
  temporaryRuleCreated: false, temporaryRuleCreationAttempted: false,
  temporaryRuleRemoved: null, comparisonBaseline: null, comparisonOriginalDenial: null,
  fullSandboxAcceptance: false, steps: [], probes: [],
};
let root;
let listener;
let accepted = 0;
let ruleMayExist = false;
let powershell;
let resultCode = 0;
const environmentBefore = new Map();

function psLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function saveReport() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
function setEnvironment(key, value) {
  if (!environmentBefore.has(key)) environmentBefore.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
async function bounded(action, label, timeoutMs) {
  let timer;
  const started = Date.now();
  try {
    const value = await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its diagnostic timeout`)), timeoutMs);
    })]);
    report.steps.push({ name: label, completed: true, elapsedMs: Date.now() - started });
    return value;
  } catch (error) {
    report.steps.push({ name: label, completed: false, elapsedMs: Date.now() - started });
    throw error;
  } finally { clearTimeout(timer); }
}
function trustedPowerShell(source, timeoutMs = 15_000) {
  // The runner invokes PowerShell 7, while this diagnostic deliberately uses
  // system Windows PowerShell. Never let the runner's module path select PS7 modules.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  env.PSModulePath = path.join(path.dirname(powershell), "Modules");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; ${source}`], {
    encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 512_000, env,
  });
  if (result.error || result.status !== 0) throw new Error(`Trusted diagnostic PowerShell failed (${result.error?.code || result.status})`);
  return result.stdout.trim();
}
function firewallSnapshot() {
  return JSON.parse(trustedPowerShell(`
    $policy = New-Object -ComObject HNetCfg.FwPolicy2
    $rules = @($policy.Rules | Where-Object { $_.Name -like 'codex_sandbox_offline_block_*' } | ForEach-Object {
      $users = $null; try { $users = [string]$_.LocalUserAuthorizedList } catch {}
      [ordered]@{ name = $_.Name; enabled = [bool]$_.Enabled; profiles = [int]$_.Profiles; direction = [int]$_.Direction; action = [int]$_.Action;
        protocol = [int]$_.Protocol; remoteAddresses = [string]$_.RemoteAddresses; remotePorts = [string]$_.RemotePorts; localUserAuthorizedList = $users }
    })
    $services = @(Get-Service BFE, MpsSvc | Select-Object Name, @{ Name = 'Status'; Expression = { $_.Status.ToString() } })
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Select-Object Name, @{ Name = 'Enabled'; Expression = { $_.Enabled.ToString() } })
    [ordered]@{ currentProfiles = [int]$policy.CurrentProfileTypes; localPolicyModifyState = [int]$policy.LocalPolicyModifyState;
      services = $services; profiles = $profiles; codexBlockRules = $rules } | ConvertTo-Json -Depth 6 -Compress
  `));
}
function hostConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (connected) => { socket.destroy(); resolve(connected); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
    socket.setTimeout(3_000, () => finish(false));
  });
}
function removeTemporaryRule() {
  trustedPowerShell(`
    $policy = New-Object -ComObject HNetCfg.FwPolicy2
    $name = ${psLiteral(ruleName)}
    if (@($policy.Rules | Where-Object { $_.Name -eq $name }).Count -gt 0) { $policy.Rules.Remove($name) }
    if (@($policy.Rules | Where-Object { $_.Name -eq $name }).Count -ne 0) { throw 'The fixture rule was not removed' }
  `, 20_000);
  ruleMayExist = false; report.temporaryRuleRemoved = true;
}

try {
  assert.equal(process.platform, "win32", "A real Windows CI host is required");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "This diagnostic is restricted to disposable GitHub Actions runners");
  assert.ok(process.argv.length === 3 && process.argv[2] === "--allow-setup", "Explicit disposable sandbox setup authorization is required");
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  assert.ok(systemRoot && /^[A-Za-z]:[\\/]/.test(systemRoot) && !systemRoot.includes("\0"), "Trusted Windows system directory is required");
  powershell = fs.realpathSync.native(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"));
  assert.equal(trustedPowerShell("([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"), "True", "The disposable CI process must already be administrator; no UAC approval is automated");

  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-network-diagnostic-")));
  const workspace = path.join(root, "workspace"); const settings = path.join(root, "settings"); const plugins = path.join(root, "plugins");
  for (const directory of [workspace, settings, plugins]) fs.mkdirSync(directory);
  const users = path.join(settings, "users.json"); const appSettings = path.join(settings, "app-settings.json");
  fs.writeFileSync(users, JSON.stringify({ allowedRoots: [workspace], users: [] }));
  fs.writeFileSync(appSettings, "{}\n");
  fs.writeFileSync(path.join(settings, "agent-execution.json"), JSON.stringify({ environment: "native", sandboxMode: "elevated" }));
  for (const key of Object.keys(process.env)) if (/^(?:CROWNFORGE_WINDOWS_|CROWNFORGE_WSL_|CODEX_|OPENAI_|ANTHROPIC_)/i.test(key) || ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN"].includes(key)) setEnvironment(key, undefined);
  for (const [key, value] of Object.entries({ USERS_CONFIG: users, APP_SETTINGS_CONFIG: appSettings, WORKSPACE_DIR: workspace, TEAM_STORE_ROOT: path.join(root, "teams"), PLUGINS_DIR: plugins,
    CREWFORGE_DESKTOP: "1", CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT: "native", CROWNFORGE_WINDOWS_SANDBOX_MODE: "elevated", VLLM_API_URL: "http://127.0.0.1:9/v1", VLLM_API_KEY: "" })) setEnvironment(key, value);

  // Every backend import occurs after the independent configuration is in place.
  const native = await import("../backend/dist/agent/windowsNativeSandbox.js");
  const { runWorkspaceProcess } = await import("../backend/dist/agent/processSandbox.js");
  assert.equal(native.WINDOWS_NATIVE_RUNTIME_VERSION, "0.160.0");
  let capability = await bounded(() => native.probeWindowsNativeSandbox(), "read native readiness", 20_000);
  if (!capability.available) await bounded(() => native.setupWindowsNativeSandbox(workspace, "elevated"), "explicit disposable sandbox setup", 180_000);
  capability = await bounded(() => native.probeWindowsNativeSandbox(), "verify native readiness", 20_000);
  assert.equal(capability.available, true, "Native sandbox must be ready before network comparison");
  report.runtimeVersion = capability.runtimeVersion;
  report.before = firewallSnapshot();

  listener = net.createServer((socket) => { accepted += 1; socket.end(); });
  await bounded(() => new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); }), "start fixture loopback listener", 5_000);
  const address = listener.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  report.fixtureEndpoint = { host: "127.0.0.1", port };
  report.hostPositiveControl = await bounded(() => hostConnect(port), "host positive TCP control", 5_000);
  assert.equal(report.hostPositiveControl, true, "A blocked or unstarted listener cannot establish sandbox denial");

  const filesystem = { workspaceDir: workspace, readPaths: ["."], writePaths: [] };
  const execute = async (name, source) => {
    const started = Date.now(); const controller = new AbortController(); let deadlineReached = false;
    const timeout = setTimeout(() => { deadlineReached = true; controller.abort(); }, PROBE_TIMEOUT_MS);
    let output;
    const metadata = { name, timeoutMs: PROBE_TIMEOUT_MS, elapsedMs: 0, errorKind: null, exitCode: null, success: false };
    try {
      // The 30k deadline includes readiness/launch. Five seconds only permit
      // cancellation bookkeeping to finish; they do not authorize a longer payload.
      output = await bounded(() => runWorkspaceProcess({ executable: native.windowsNativePowerShellExecutable(), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source],
        cwd: workspace, filesystem, networkMode: "deny", signal: controller.signal, limits: { wallTimeMs: PROBE_TIMEOUT_MS }, maxOutputBytes: 16_384 }), name, PROBE_TIMEOUT_MS + 5_000);
      const exit = output.match(/^Error: Process exited with code (-?\d+)/);
      if (deadlineReached || /^Error: Timeout/.test(output)) metadata.errorKind = "timeout";
      else if (exit) { metadata.errorKind = "exit"; metadata.exitCode = Number(exit[1]); }
      else if (/^Error: Stopped/.test(output)) metadata.errorKind = "cancelled";
      else if (/^Error:/.test(output)) metadata.errorKind = "launcher";
      else { metadata.success = true; metadata.exitCode = 0; }
    } catch { metadata.errorKind = deadlineReached ? "timeout" : "launcher"; }
    finally {
      clearTimeout(timeout); metadata.elapsedMs = Date.now() - started; report.probes.push(metadata);
      console.log(JSON.stringify({ probe: name, elapsedMs: metadata.elapsedMs, errorKind: metadata.errorKind, exitCode: metadata.exitCode }));
    }
    // Cancellation preserves the native lease until actual process close. Allow
    // its existing forced-termination window to finish before the next probe.
    if (metadata.errorKind === "timeout" || metadata.errorKind === "cancelled") await new Promise((resolve) => setTimeout(resolve, 1_500));
    return { output: metadata.success ? output : undefined, metadata };
  };
  const checkMarker = (probe, marker) => {
    if (probe.metadata.success && !probe.output.includes(marker)) { probe.metadata.success = false; probe.metadata.errorKind = "unexpected_output"; }
    return probe.metadata;
  };
  const consoleStart = await execute("console startup control", "[Console]::WriteLine('DIAG_CONSOLE_STARTED')");
  report.consoleStartup = checkMarker(consoleStart, "DIAG_CONSOLE_STARTED");
  const cmdletStart = await execute("Write-Output startup control", "Write-Output 'DIAG_CMDLET_STARTED'");
  report.cmdletStartup = checkMarker(cmdletStart, "DIAG_CMDLET_STARTED");
  const modules = await execute("PowerShell module categories", "$paths = [Environment]::GetEnvironmentVariable('PSModulePath'); $ps5 = $paths -match '(?i)WindowsPowerShell[\\\\/]v1[.]0[\\\\/]Modules'; $ps7 = $paths -match '(?i)PowerShell[\\\\/]7([\\\\/]|$)'; [Console]::WriteLine('DIAG_MODULES:' + $PSVersionTable.PSVersion.Major + ':' + $ps5.ToString().ToLowerInvariant() + ':' + $ps7.ToString().ToLowerInvariant())");
  const moduleCategories = modules.output?.match(/DIAG_MODULES:(\d+):(true|false):(true|false)/);
  report.moduleCategories = moduleCategories ? { powershellMajor: Number(moduleCategories[1]), hasPS5Modules: moduleCategories[2] === "true", hasPS7Modules: moduleCategories[3] === "true" } : null;
  if (modules.metadata.success && !moduleCategories) { modules.metadata.success = false; modules.metadata.errorKind = "unexpected_output"; }
  const whoami = path.join(systemRoot, "System32/whoami.exe");
  const identity = await execute("read actual sandbox whoami SID", `$identity = & ${psLiteral(whoami)} /user /fo csv /nh; [regex]::Match(($identity -join ' '), 'S-1-[0-9-]+').Value`);
  const sid = identity.output?.trim();
  report.sandboxWhoamiSid = sid && /^S-1-[0-9-]+$/.test(sid) ? sid : null;
  if (identity.metadata.success && !report.sandboxWhoamiSid) { identity.metadata.success = false; identity.metadata.errorKind = "unexpected_output"; }
  report.before.codexBlockRules = report.before.codexBlockRules.map((rule) => ({ ...rule, matchesWhoamiSid: report.sandboxWhoamiSid ? Boolean(rule.localUserAuthorizedList?.includes(sid)) : null }));
  const tcp = `$client = [Net.Sockets.TcpClient]::new(); $connected = $false; try { $task = $client.ConnectAsync('127.0.0.1', ${port}); try { $connected = $task.Wait(4000) -and $client.Connected } catch {} } catch {} finally { $client.Dispose() }; `;
  const originalCommand = tcp + "if ($connected) { Write-Output 'DIAG_NETWORK_CONNECTED' } else { Write-Output 'DIAG_NETWORK_DENIED' }";
  const consoleCommand = tcp + "if ($connected) { [Console]::WriteLine('DIAG_NETWORK_CONNECTED') } else { [Console]::WriteLine('DIAG_NETWORK_DENIED') }";
  const commandHash = (command) => crypto.createHash("sha256").update(command).digest("hex");
  report.originalCommandSha256 = commandHash(originalCommand); report.consoleCommandSha256 = commandHash(consoleCommand);
  const probe = async (label, command) => {
    const prior = accepted; const execution = await execute(label, command);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const acceptedConnections = accepted - prior;
    if (!execution.metadata.success) return { execution: execution.metadata, connected: null, acceptedConnections, denied: null };
    const connected = execution.output.includes("DIAG_NETWORK_CONNECTED"); const markedDenied = execution.output.includes("DIAG_NETWORK_DENIED");
    if (connected === markedDenied) { execution.metadata.success = false; execution.metadata.errorKind = "unexpected_output"; return { execution: execution.metadata, connected: null, acceptedConnections, denied: null }; }
    return { execution: execution.metadata, connected, acceptedConnections, denied: !connected && acceptedConnections === 0 };
  };
  report.originalProbe = await probe("original offline TCP probe", originalCommand); report.originalDenial = report.originalProbe.denied;
  // Always run the Console control, including after a cmdlet execution failure.
  report.consoleTcpProbe = await probe("Console offline TCP control", consoleCommand);
  const baseline = report.consoleTcpProbe.denied !== null ? { name: "console_tcp", command: consoleCommand, probe: report.consoleTcpProbe }
    : report.originalProbe.denied !== null ? { name: "original_tcp", command: originalCommand, probe: report.originalProbe } : null;
  assert.ok(baseline, "Neither controlled TCP command produced a network result; execution errors are not denial");
  report.comparisonBaseline = baseline.name; report.comparisonOriginalDenial = baseline.probe.denied;
  report.probeCommandSha256 = commandHash(baseline.command);

  // This unique all-user rule affects only this fixture's one remote loopback TCP port.
  ruleMayExist = true;
  report.temporaryRuleCreationAttempted = true; report.temporaryRuleCreated = null;
  trustedPowerShell(`
    $rule = New-Object -ComObject HNetCfg.FWRule
    $rule.Name = ${psLiteral(ruleName)}; $rule.Description = 'Disposable APP_RUST fixed-port network comparison'
    $rule.Direction = 2; $rule.Action = 0; $rule.Enabled = $true; $rule.Protocol = 6
    $rule.RemoteAddresses = '127.0.0.1'; $rule.RemotePorts = '${port}'; $rule.Profiles = 2147483647
    $policy = New-Object -ComObject HNetCfg.FwPolicy2; $policy.Rules.Add($rule)
    $actual = $policy.Rules.Item(${psLiteral(ruleName)})
    if (-not $actual.Enabled -or $actual.Direction -ne 2 -or $actual.Action -ne 0 -or $actual.Protocol -ne 6 -or $actual.Profiles -ne 2147483647 -or
        $actual.RemoteAddresses -ne '127.0.0.1' -or $actual.RemotePorts -ne '${port}') { throw 'Unexpected fixture firewall rule scope' }
    try { if ($actual.LocalUserAuthorizedList) { throw 'The fixture comparison requires all users' } } catch [System.Management.Automation.PropertyNotFoundException] {}
  `, 20_000);
  report.temporaryRuleCreated = true;
  report.temporaryRule = { name: ruleName, direction: "outbound", action: "block", protocol: "TCP", remoteAddress: "127.0.0.1", remotePort: port, users: "all" };
  await new Promise((resolve) => setTimeout(resolve, 500));
  report.allUsersProbe = await probe("same offline TCP probe with the all-user fixture rule", baseline.command); report.allUsersDenial = report.allUsersProbe.denied;
  assert.ok(report.allUsersDenial !== null, "The all-user comparison returned an execution error, not network denial");
  report.withTemporaryRule = firewallSnapshot();
  report.status = "DIAGNOSTIC_COMPLETE";
} catch (error) {
  report.error = error instanceof Error ? error.message : "Network diagnostic failed";
  resultCode = 1;
} finally {
  if (ruleMayExist) {
    try { removeTemporaryRule(); }
    catch (error) { report.temporaryRuleRemoved = false; report.cleanupError = error.message; report.status = "DIAGNOSTIC_ERROR"; resultCode = 1; }
  }
  if (powershell && process.platform === "win32") {
    try { report.afterCleanup = firewallSnapshot(); }
    catch { report.snapshotError = "Post-cleanup firewall snapshot could not be read"; report.status = "DIAGNOSTIC_ERROR"; resultCode = 1; }
  }
  if (listener) {
    listener.closeAllConnections?.();
    await bounded(() => new Promise((resolve) => listener.close(resolve)), "close fixture listener", 5_000).catch(() => {
      report.listenerCleanupError = "Diagnostic listener could not close within its timeout"; report.status = "DIAGNOSTIC_ERROR"; resultCode = 1;
    });
  }
  for (const [key, value] of environmentBefore) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (root) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); }
    catch { report.fixtureCleanupError = "Diagnostic fixture could not be removed"; report.status = "DIAGNOSTIC_ERROR"; resultCode = 1; }
  }
  report.endedAt = new Date().toISOString(); saveReport();
  console.log(`${report.status} network diagnostic; this is not full sandbox acceptance`);
  console.log(JSON.stringify({ originalDenial: report.originalDenial, allUsersDenial: report.allUsersDenial, temporaryRuleCreated: report.temporaryRuleCreated,
    temporaryRuleRemoved: report.temporaryRuleRemoved, comparisonBaseline: report.comparisonBaseline, comparisonOriginalDenial: report.comparisonOriginalDenial, moduleCategories: report.moduleCategories }));
  // Also bounds a timed-out setup RPC whose internal notification timer is still pending.
  process.exit(resultCode);
}
