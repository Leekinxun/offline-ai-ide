import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(repo, ".artifacts", "windows-wsl-smoke");
const reportPath = path.join(artifactDir, "report.json");
const startedAt = new Date().toISOString();
const checks = [];
let root;
let shutdownProcessSessions;

function record(name, detail = {}) { checks.push({ name, status: "PASS", ...detail }); }
async function step(name, fn) {
  try { const detail = await fn(); record(name, detail); }
  catch (error) {
    checks.push({ name, status: "FAIL", message: error instanceof Error ? error.stack || error.message : String(error) });
    throw error;
  }
}
function system32(name) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  assert.ok(systemRoot, "SystemRoot/WINDIR is required");
  return path.join(systemRoot, "System32", name);
}
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, ...options });
  if (result.status !== 0 || result.error) {
    throw new Error(`${path.basename(executable)} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  }
  return String(result.stdout || "").trim();
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
async function until(predicate, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function combinedText(poll) { return poll.events.map((event) => event.text).join(""); }
async function waitStableFile(file, settleMs = 1200, timeoutMs = 7000) {
  let last = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let stableSince = Date.now();
  await until(() => {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current !== last) { last = current; stableSince = Date.now(); }
    return Date.now() - stableSince >= settleMs ? current : undefined;
  }, "heartbeat writes to stop", timeoutMs);
  return last;
}

if (process.platform !== "win32") throw new Error("windows-wsl-smoke must run on a real Windows host with WSL2; this run is intentionally not skipped or treated as PASS.");

try {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-wsl-win-smoke-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const config = path.join(root, "config");
  const plugins = path.join(root, "plugins");
  for (const directory of [artifactDir, workspace, outside, config, plugins]) fs.mkdirSync(directory, { recursive: true });

  Object.assign(process.env, {
    USERS_CONFIG: path.join(config, "users.json"),
    APP_SETTINGS_CONFIG: path.join(config, "app-settings.json"),
    WORKSPACE_DIR: workspace,
    PLUGINS_DIR: plugins,
    TEAM_STORE_ROOT: path.join(root, "team-store"),
  });

  await step("enable fixture directory case sensitivity", () => {
    run(system32("fsutil.exe"), ["file", "setCaseSensitiveInfo", workspace, "enable"]);
    fs.mkdirSync(path.join(workspace, "allowednested"));
    run(system32("fsutil.exe"), ["file", "setCaseSensitiveInfo", path.join(workspace, "allowednested"), "enable"]);
    return { workspace };
  });
  fs.mkdirSync(path.join(workspace, ".git")); fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ scripts: { smoke: "node -e \"require('fs').writeFileSync('allowednested/npm.txt','npm-ok')\"" } }, null, 2));
  fs.writeFileSync(path.join(workspace, "allowednested", "input.txt"), "allowed"); fs.writeFileSync(path.join(workspace, ".env"), "SECRET_ENV_CANARY=1\n");
  fs.writeFileSync(path.join(workspace, ".git", "control"), "git-control"); fs.writeFileSync(path.join(outside, "private.txt"), "outside-canary");
  writeJson(path.join(config, "users.json"), { users: [] }); writeJson(path.join(config, "app-settings.json"), {});

  const [{ probeWslExecution }, shell, sessions] = await Promise.all([
    import("../backend/dist/agent/wslExecution.js"),
    import("../backend/dist/agent/shell.js"),
    import("../backend/dist/run/processSessions.js"),
  ]);
  const { runWorkspaceCommand, runReadOnlyShellCommand } = shell;
  ({ shutdownProcessSessions } = sessions);
  const { startAgentProcessSession, pollProcessSession, inputProcessSession, stopProcessSession } = sessions;
  const owner = { workspaceDir: workspace, owner: "windows-wsl-smoke" };

  await step("probe WSL2 execution capability", async () => {
    const capability = await probeWslExecution({ refresh: true });
    assert.equal(capability.available, true, JSON.stringify(capability));
    return { reasonCode: capability.reasonCode, distro: capability.distro || null };
  });

  await step("run Bash, Node, and npm project script in WSL workspace", async () => {
    const output = await runWorkspaceCommand("printf \"bash:%s\\n\" \"$BASH_VERSION\"; node -e \"console.log('node:'+process.version)\"; npm run -s smoke; cat allowednested/npm.txt", workspace, undefined, {
      compatibilityShellAuthorized: true,
      filesystem: { workspaceDir: workspace, readPaths: ["."], writePaths: ["."] },
      resourceLimits: { wallTimeMs: 60_000 },
    });
    assert.doesNotMatch(output, /^Error:/); assert.match(output, /bash:/); assert.match(output, /node:v/); assert.match(output, /npm-ok/);
    return { output: output.slice(0, 300) };
  });

  await step("read-only queries run through WSL without mutation", async () => {
    const ls = await runReadOnlyShellCommand("ls allowednested", workspace, undefined, { workspaceDir: workspace, readPaths: ["."], writePaths: [] });
    const node = await runReadOnlyShellCommand("node --version", workspace, undefined, { workspaceDir: workspace, readPaths: ["."], writePaths: [] });
    assert.match(ls, /input\.txt|npm\.txt/);
    assert.match(node, /^v\d+\./);
    return { ls, node };
  });

  await step("secrets, case aliases, outside paths, and network are denied", async () => {
    const command = [
      "for target in .env .ENV ../outside/private.txt; do if cat \"$target\" >/dev/null 2>&1; then echo LEAK:$target; else echo DENIED:$target; fi; done",
      "node -e \"require('net').connect(443,'example.com').on('connect',()=>{console.log('NETLEAK');process.exit(0)}).on('error',()=>{console.log('NETDENIED')});setTimeout(()=>{console.log('NETTIMEOUT');process.exit(2)},2500)\"",
    ].join("; ");
    const output = await runWorkspaceCommand(command, workspace, undefined, {
      compatibilityShellAuthorized: true,
      filesystem: { workspaceDir: workspace, readPaths: ["allowednested"], writePaths: ["allowednested"] },
      resourceLimits: { wallTimeMs: 10_000 },
    });
    assert.doesNotMatch(output, /LEAK|NETLEAK/); assert.match(output, /DENIED:\.env/); assert.match(output, /DENIED:\.ENV/);
    assert.match(output, /DENIED:\.\.\/outside\/private\.txt/); assert.match(output, /NETDENIED|NETTIMEOUT/);
    return { output };
  });

  await step("agent process session accepts input and stop reaps payload loop", async () => {
    const marker = path.join(workspace, "allowednested", "session-heartbeat.txt").replaceAll("\\", "/");
    const command = `read line; echo input:$line; i=0; while true; do i=$((i+1)); echo $i > "${marker}"; sleep 0.3; done`;
    const session = startAgentProcessSession({ ...owner, executable: "/bin/bash", args: ["-c", command], timeoutMs: 30_000, filesystem: { workspaceDir: workspace, readPaths: ["."], writePaths: ["."] } });
    await inputProcessSession(owner, session.id, "hello\n", true);
    const seen = await until(() => {
      const poll = pollProcessSession(owner, session.id);
      return combinedText(poll).includes("input:hello") && fs.existsSync(path.join(workspace, "allowednested", "session-heartbeat.txt")) ? poll : undefined;
    }, "session heartbeat and input echo");
    stopProcessSession(owner, session.id);
    const stopped = await until(() => {
      const poll = pollProcessSession(owner, session.id, seen.nextCursor);
      return poll.session.status !== "running" ? poll : undefined;
    }, "session cancellation");
    const heartbeat = path.join(workspace, "allowednested", "session-heartbeat.txt");
    const after = await waitStableFile(heartbeat, 1200, 7000);
    assert.equal(stopped.session.status, "cancelled");
    return { sessionId: session.id, status: stopped.session.status, heartbeat: after.trim() };
  });

  shutdownProcessSessions();
  writeJson(reportPath, { status: "PASS", startedAt, endedAt: new Date().toISOString(), workspace, checks });
  console.log(`PASS windows-wsl-smoke ${reportPath}`);
} catch (error) {
  writeJson(reportPath, { status: "FAIL", startedAt, endedAt: new Date().toISOString(), checks, error: error instanceof Error ? error.stack || error.message : String(error) });
  console.error(`FAIL windows-wsl-smoke ${reportPath}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  try { shutdownProcessSessions?.(); } catch { /* best effort */ }
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (root && process.env.CROWNFORGE_WSL_KEEP_SMOKE !== "1") fs.rmSync(root, { recursive: true, force: true });
}
