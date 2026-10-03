import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentShellInvocation, usesNativeWindowsAgent, windowsInspectionInvocation } from "./windowsShell.js";
import { defaultAgentShellLimits, runWorkspaceCommand } from "./shell.js";
import { setWindowsNativeSandboxTestHooks } from "./windowsNativeSandbox.js";

test("native invocation uses fixed PowerShell and keeps the approved command as one argument", (t) => {
  const f = windowsFixture(t);
  process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "native";
  const command = "Get-ChildItem; Write-Output 'space and quotes'";
  const invocation = agentShellInvocation(command);
  assert.equal(invocation.executable, f.powershell);
  assert.equal(invocation.args.at(-2), "-Command"); assert.equal(invocation.args.at(-1), command);
  const inspection = windowsInspectionInvocation("Get-Content", ["-LiteralPath", "a'b.txt", "-TotalCount", "5"], f.root);
  assert.match(inspection.args.at(-1)!, /-LiteralPath 'a''b\.txt' -TotalCount 5/);
});

function windowsFixture(t: test.TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-native-shell-")));
  const powershell = path.join(root, "powershell.exe"); fs.writeFileSync(powershell, "fixture");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const keys = ["APP_SETTINGS_CONFIG", "CREWFORGE_DESKTOP", "CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT", "CROWNFORGE_WINDOWS_SANDBOX_MODE", "PATH"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  process.env.APP_SETTINGS_CONFIG = path.join(root, "private", "app-settings.json");
  process.env.CREWFORGE_DESKTOP = "1";
  process.env.PATH = "";
  delete process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT; delete process.env.CROWNFORGE_WINDOWS_SANDBOX_MODE;
  setWindowsNativeSandboxTestHooks({ platform: "win32", arch: "x64", backendRoot: root, stateHome: path.join(root, "private", "codex-native-sandbox"), powershellExecutable: powershell });
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
    for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    setWindowsNativeSandboxTestHooks(undefined); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, powershell };
}

test("a fresh Windows selection defaults to trusted PowerShell even with no Bash or PATH tools", (t) => {
  const f = windowsFixture(t);
  assert.equal(usesNativeWindowsAgent(), true);
  assert.equal(agentShellInvocation("Write-Output 'native'").executable, f.powershell);
  assert.equal(windowsInspectionInvocation("Get-Location", [], f.root).executable, f.powershell);
  assert.equal(fs.existsSync(path.join(f.root, "private")), false);
});

test("WSL Bash is selected only by the explicit Windows execution setting", (t) => {
  windowsFixture(t); process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "wsl";
  assert.equal(usesNativeWindowsAgent(), false);
  assert.deepEqual(agentShellInvocation("printf wsl"), { executable: "/bin/bash", args: ["-c", "printf wsl"] });
  process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "native";
  assert.equal(usesNativeWindowsAgent(), true);
});

test("Windows Web retains Bash and resource limits even with native desktop settings and overrides", (t) => {
  const f = windowsFixture(t); const directory = path.join(f.root, "private"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "agent-execution.json"), JSON.stringify({ environment: "native", sandboxMode: "elevated" }));
  process.env.CROWNFORGE_WINDOWS_AGENT_ENVIRONMENT = "native";
  for (const desktop of [undefined, "0"]) {
    if (desktop === undefined) delete process.env.CREWFORGE_DESKTOP; else process.env.CREWFORGE_DESKTOP = desktop;
    assert.equal(usesNativeWindowsAgent(), false);
    assert.deepEqual(agentShellInvocation("printf web"), { executable: "/bin/bash", args: ["-c", "printf web"] });
    assert.equal(defaultAgentShellLimits().cpuTimeMs, 60_000);
    assert.equal(defaultAgentShellLimits().maxOpenFiles, 256);
  }
});

test("a missing native sandbox runtime returns an execution error without switching to a host shell or WSL", async (t) => {
  const f = windowsFixture(t);
  const output = await runWorkspaceCommand("Write-Output 'must-not-run'", f.root, undefined, { compatibilityShellAuthorized: true });
  assert.match(output, /^Error: .*Windows sandbox runtime is missing/);
  assert.equal(fs.existsSync(path.join(f.root, "private")), false);
  assert.equal(usesNativeWindowsAgent(), true);
});
