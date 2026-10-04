import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planReadOnlyShell, resolveReadOnlyExecutable } from "./readOnlyShell.js";
import { classifyToolApproval } from "./toolApproval.js";
import { runReadOnlyShellCommand } from "./shell.js";
import { probeFilesystemIsolation } from "./processSandbox.js";
import { evaluateShellCommand } from "./toolPolicy.js";

test("only a small exact set of read-only queries bypasses approval", () => {
  for (const command of [
    "pwd", "ls", "ls -la", "ls src", "cat README.md", "find src -maxdepth 2 -type f -print",
    "head -n 10 README.md", "tail -n 10 README.md", "wc -l README.md", "sed -n '1,20p' README.md", "find src -name '*.ts' -print",
    "python3 --version", "python --version", "python3 -m ruff --version", "python3 -I -B -m ruff --version", "node --version", "git --version", "ruff --version",
  ]) {
    assert.ok(planReadOnlyShell(command), command);
    assert.equal(classifyToolApproval("bash", { command }).kind, "none", command);
  }
  for (const command of ["npm test", "python3 test.py", "python3 -m pytest --version", "find . -delete", "cat .env", "ls > result", "pwd; touch result", "ls .env", "ls ../other", "python3 --version && ls", "(pwd)", "PATH=. pwd", "/tmp/pwd", "echo $(pwd)"]) {
    assert.equal(planReadOnlyShell(command), null, command);
    assert.notEqual(classifyToolApproval("bash", { command }).kind, "none", command);
  }
  assert.equal(classifyToolApproval("bash", { command: "pwd", allow_network: true }).kind, "approval");
  assert.deepEqual(planReadOnlyShell("python3 -m ruff --version")?.args, ["-I", "-B", "-m", "ruff", "--version"]);
  assert.deepEqual(planReadOnlyShell("python3 -I -B -m ruff --version")?.args, ["-I", "-B", "-m", "ruff", "--version"]);
});

test("auto-approved query never selects an executable supplied by a workspace or untrusted PATH", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-query-binary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "pwd"), "#!/bin/sh\ntouch result\n", { mode: 0o755 });
  assert.equal(resolveReadOnlyExecutable(planReadOnlyShell("pwd")!, root, root), null);
  assert.equal(resolveReadOnlyExecutable(planReadOnlyShell("pwd")!, root, "."), null);
});

test("desktop Git ownership is bounded by its approved runtime while writable runtime files remain untrusted", (t) => {
  if (process.platform !== "darwin") { t.skip("macOS bundled runtime ownership policy"); return; }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-desktop-query-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.chmodSync(parent, 0o775); // Like a standard /Applications ancestor.
  const root = path.join(parent, "runtime"), workspace = path.join(parent, "workspace");
  fs.mkdirSync(root, { mode: 0o755 }); fs.mkdirSync(workspace);
  const executable = path.join(root, "git"); fs.writeFileSync(executable, "owned fixture", { mode: 0o755 });
  const keys = ["CREWFORGE_DESKTOP", "CROWNFORGE_IDE_CORE_EXECUTABLE", "CROWNFORGE_GIT_EXECUTABLE", "CROWNFORGE_GIT_RUNTIME_ROOT"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, { CREWFORGE_DESKTOP: "1", CROWNFORGE_IDE_CORE_EXECUTABLE: "/fixture/core", CROWNFORGE_GIT_EXECUTABLE: executable, CROWNFORGE_GIT_RUNTIME_ROOT: root });
    const plan = planReadOnlyShell("git --version")!;
    assert.equal(resolveReadOnlyExecutable(plan, workspace, ""), fs.realpathSync.native(executable));
    fs.chmodSync(executable, 0o775);
    assert.equal(resolveReadOnlyExecutable(plan, workspace, ""), null);
    fs.chmodSync(executable, 0o755); fs.chmodSync(root, 0o775);
    assert.equal(resolveReadOnlyExecutable(plan, workspace, ""), null);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("read-only runner executes argv safely and refuses to fall back to a writable shell", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-readonly-query-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "sample.md"), "keep\n");
  assert.match(await runReadOnlyShellCommand("pwd; touch unexpected", root), /^Error: Command is not/);
  assert.equal(fs.existsSync(path.join(root, "unexpected")), false);
  const capability = probeFilesystemIsolation();
  const result = await runReadOnlyShellCommand("ls", root);
  if (!capability.available) { assert.match(result, /^Error:/); return; }
  assert.match(result, /sample\.md/);
  assert.equal(await runReadOnlyShellCommand("cat sample.md", root), "keep");
  assert.match(await runReadOnlyShellCommand("find . -name '*.md' -print", root), /sample\.md/);
  fs.writeFileSync(path.join(root, ".env"), "private=value\n");
  assert.match(await runReadOnlyShellCommand("cat .env", root), /^Error:/);
  const nested = path.join(root, "nested"); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "credentials.json"), '{"token":"private"}');
  assert.match(await runReadOnlyShellCommand("cat nested/credentials.json", root), /^Error:/);
  assert.equal(await runReadOnlyShellCommand("pwd", root), fs.realpathSync.native(root));
  assert.equal(fs.readFileSync(path.join(root, "sample.md"), "utf8"), "keep\n");
});

test("ordinary parenthesized shell groups require approval while substitution and write escapes remain blocked", () => {
  const options = { compatibilityShellAuthorized: true, workspaceDir: os.tmpdir() };
  const command = 'python3 --version && (python3 -m ruff --version || echo "no ruff module")';
  assert.equal(evaluateShellCommand(command).allowed, false);
  assert.equal(evaluateShellCommand(command, options).allowed, true);
  assert.equal(classifyToolApproval("bash", { command }).kind, "approval");
  for (const unsafe of ["echo $(pwd)", "echo `pwd`", "f() { pwd; }; f", "(tee /outside/result)", "(echo hi) >/outside/result", "(curl https://example.test)"]) {
    assert.equal(evaluateShellCommand(unsafe, options).allowed, false, unsafe);
  }
});

test("network requests, process sessions, spelling changes, and composed commands never inherit automatic query approval", () => {
  for (const command of ["pwd", "ls -la", "cat README.md", "find src -maxdepth 2 -type f -print", "python3 --version", "python3 -m ruff --version"]) {
    for (const allow_network of [true, "true", 1, null]) {
      assert.notEqual(classifyToolApproval("bash", { command, allow_network }).kind, "none", `${command}: ${allow_network}`);
    }
    assert.equal(classifyToolApproval("process_start", { command }).kind, "approval");
  }
  for (const command of [
    "./pwd", "/usr/bin/pwd", "env pwd", "command pwd", "PWD", "pw\\d", "ls -R", "ls --dereference", "ls -- /outside",
    "python3 -m localmodule --version", "python3 -m ruff --version extra", "python3 --version script.py",
    "python3 --version; ls", "pwd && ls", "(pwd)", "pwd | cat", "pwd > output", "pwd\nls",
    "ls src/*", "ls *.md", "ls src/[a-z]*.ts",
  ]) {
    assert.equal(planReadOnlyShell(command), null, command);
    assert.notEqual(classifyToolApproval("bash", { command }).kind, "none", command);
  }
  for (const command of ["ls src/*", "ls *.md", "ls src/[a-z]*.ts"]) {
    assert.equal(classifyToolApproval("bash", { command }).kind, "approval", command);
  }
});

test("trusted query resolver rejects an absolute PATH impostor even when a valid binary occurs later", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-query-path-"));
  const workspace = path.join(root, "workspace"); const fakeBin = path.join(root, "fake-bin");
  fs.mkdirSync(workspace); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "pwd"), "#!/bin/sh\nprintf fake\n", { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(resolveReadOnlyExecutable(planReadOnlyShell("pwd")!, workspace, `${fakeBin}${path.delimiter}/bin`), null);
  fs.unlinkSync(path.join(fakeBin, "pwd"));
  fs.symlinkSync(path.join(workspace, "pwd"), path.join(fakeBin, "pwd"));
  fs.writeFileSync(path.join(workspace, "pwd"), "#!/bin/sh\nprintf workspace\n", { mode: 0o755 });
  assert.equal(resolveReadOnlyExecutable(planReadOnlyShell("pwd")!, workspace, fakeBin), null);
});

test("approving ordinary groups does not bypass hard deletion and substitution denials", () => {
  const options = { compatibilityShellAuthorized: true, workspaceDir: os.tmpdir() };
  for (const command of ["(rm file.txt)", "( rm file.txt )", "((rm file.txt))", "pwd && (rm file.txt)", "(echo $(pwd))", "(echo `pwd`)", "function f() { pwd; }", "function f { pwd; }; f"]) {
    assert.equal(evaluateShellCommand(command, options).allowed, false, command);
  }
});
