import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { probeNetworkIsolation } from "./processSandbox.js";
import { runWorkspaceCommand } from "./shell.js";

const networkCapability = probeNetworkIsolation();
const networkHelperSkip = networkCapability.available
  ? false
  : `hard network isolation unavailable: ${networkCapability.reason}`;

test("runs a policy-permitted compatibility shell command asynchronously", { skip: networkHelperSkip }, async () => {
  const output = await runWorkspaceCommand("printf ok", process.cwd());
  assert.equal(output, "ok");
});

test("aborts an in-flight shell command", { skip: networkHelperSkip }, async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = runWorkspaceCommand("sleep 10", process.cwd(), controller.signal);
  setTimeout(() => controller.abort(), 50);
  assert.match(await pending, /stopped/i);
  assert.ok(Date.now() - startedAt < 2000);
});

test("fails closed on shell syntax unless compatibility execution is explicitly authorized", async () => {
  const output = await runWorkspaceCommand("printf 'a' | wc -c", process.cwd());
  assert.match(output, /shell syntax requires explicit compatibility-shell authorization/i);
});

test("authorized compatibility execution still applies destructive-command policy", { skip: networkHelperSkip }, async () => {
  const options = { compatibilityShellAuthorized: true };
  const output = await runWorkspaceCommand("printf 'a' | wc -c", process.cwd(), undefined, options);
  assert.equal(output, "1");

  for (const command of ["sudo printf ok", "rm harmless", "cat ../outside", "node -e 'process.stdout.write(1)'"]) {
    const blocked = await runWorkspaceCommand(command, process.cwd(), undefined, options);
    assert.match(blocked, /^Error: Command blocked by workspace policy:/, command);
  }
});

test("compatibility shell applies CPU and open-file hard limits before the approved command", { skip: process.platform === "win32" ? "POSIX ulimit is unavailable on Windows" : networkHelperSkip }, async () => {
  const output = await runWorkspaceCommand(
    "ulimit -H -t; ulimit -H -n",
    process.cwd(),
    undefined,
    {
      compatibilityShellAuthorized: true,
      resourceLimits: { cpuTimeMs: 2_000, maxOpenFiles: 64, memoryBytes: undefined },
    }
  );
  const [cpuSeconds, openFiles] = output.split(/\s+/).map(Number);
  assert.ok(cpuSeconds <= 2, output);
  assert.ok(openFiles <= 64, output);
});

test("agent shell keeps local filesystem reads available under hard network deny", { skip: networkHelperSkip }, async () => {
  const output = await runWorkspaceCommand("wc -c package.json", process.cwd());
  assert.match(output, /^\d+\s+package\.json$/);
});

test("approved script cannot connect to a loopback socket", { skip: networkHelperSkip }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-network-test-"));
  const scriptPath = path.join(directory, "connect.cjs");
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    fs.writeFileSync(scriptPath, `
      const net = require("net");
      const socket = net.connect({ host: "127.0.0.1", port: Number(process.argv[2]) });
      socket.once("connect", () => { process.stdout.write("CONNECTED"); socket.destroy(); });
      socket.once("error", () => process.stdout.write("DENIED"));
      setTimeout(() => { process.stdout.write("TIMEOUT"); socket.destroy(); }, 1000).unref();
    `);
    const output = await runWorkspaceCommand(
      `node ${JSON.stringify(scriptPath)} ${address.port}`,
      directory
    );
    assert.equal(output, "DENIED");
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("glob discovery with /dev/null and descriptor copies executes in the workspace", { skip: networkHelperSkip }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-shell-glob-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "interview/q 1"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "interview/q 1/题目.md"), "fixture");
  const output = await runWorkspaceCommand("ls interview/*/题目.md 2>/dev/null; printf found", workspace, undefined, { compatibilityShellAuthorized: true });
  assert.match(output, /interview\/q 1\/题目.md/); assert.match(output, /found/);
  assert.equal(await runWorkspaceCommand("printf stderr 1>&2", workspace, undefined, { compatibilityShellAuthorized: true }), "stderr");
});

test("relative and in-workspace absolute redirects work while outside targets remain unchanged", { skip: networkHelperSkip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-shell-write-"));
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace); fs.mkdirSync(path.join(workspace, "nested"));
  const outside = path.join(root, "outside.txt"); fs.writeFileSync(outside, "sentinel");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { compatibilityShellAuthorized: true };
  assert.doesNotMatch(await runWorkspaceCommand("printf relative > nested/result.txt", workspace, undefined, options), /^Error:/);
  const target = path.join(workspace, "nested/absolute result.txt");
  assert.doesNotMatch(await runWorkspaceCommand(`printf absolute > "${target}"`, workspace, undefined, options), /^Error:/);
  assert.equal(fs.readFileSync(target, "utf8"), "absolute");
  assert.equal(fs.readFileSync(path.join(workspace, "nested/result.txt"), "utf8"), "relative");
  assert.match(await runWorkspaceCommand(`printf forbidden > "${outside}"`, workspace, undefined, options), /^Error:/);
  assert.equal(fs.readFileSync(outside, "utf8"), "sentinel");
});

test("portable shell can preflight and rename ten nested Unicode files without overwriting collisions", { skip: networkHelperSkip }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-shell-rename-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const directories = Array.from({ length: 10 }, (_, index) => `interview/q ${index + 1}`);
  for (const [index, relative] of directories.entries()) { fs.mkdirSync(path.join(workspace, relative), { recursive: true }); fs.writeFileSync(path.join(workspace, relative, "题目.md"), `source-${index}\n`); }
  const command = 'found=0; for dir in interview/*; do if [ ! -d "$dir" ]; then continue; fi; if [ -L "$dir" ] || [ ! -f "$dir/题目.md" ] || [ -e "$dir/TASK.md" ]; then printf "%s\\n" "Preflight failed: $dir" >&2; exit 1; fi; found=1; done; if [ "$found" = 0 ]; then exit 1; fi; for dir in interview/*; do if [ ! -d "$dir" ]; then continue; fi; mv -n "$dir/题目.md" "$dir/TASK.md" || exit 1; if [ -e "$dir/题目.md" ]; then exit 1; fi; done; printf renamed';
  const options = { compatibilityShellAuthorized: true };
  const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-shell-empty-"));
  t.after(() => fs.rmSync(emptyWorkspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(emptyWorkspace, "interview"));
  assert.match(await runWorkspaceCommand(command, emptyWorkspace, undefined, options), /^Error:/, "An empty tree must not claim that files were renamed");
  const collision = path.join(workspace, directories[9], "TASK.md"); fs.writeFileSync(collision, "existing target");
  assert.match(await runWorkspaceCommand(command, workspace, undefined, options), /^Error:/);
  assert.equal(fs.readFileSync(collision, "utf8"), "existing target");
  assert.ok(directories.every((relative) => fs.existsSync(path.join(workspace, relative, "题目.md"))), "Preflight failure must not move earlier files");
  fs.unlinkSync(collision);
  const missing = path.join(workspace, directories[8], "题目.md"); fs.unlinkSync(missing);
  assert.match(await runWorkspaceCommand(command, workspace, undefined, options), /^Error:/);
  assert.ok(directories.every((relative) => !fs.existsSync(path.join(workspace, relative, "TASK.md"))));
  fs.writeFileSync(missing, "source-8\n");
  assert.equal(await runWorkspaceCommand(command, workspace, undefined, options), "renamed");
  for (const [index, relative] of directories.entries()) {
    assert.equal(fs.existsSync(path.join(workspace, relative, "题目.md")), false);
    assert.equal(fs.readFileSync(path.join(workspace, relative, "TASK.md"), "utf8"), `source-${index}\n`);
  }
});
