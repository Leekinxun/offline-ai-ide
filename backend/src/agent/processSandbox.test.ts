import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { INTERNAL_NODE_RUNTIME } from "../utils/nodeRuntime.js";
import {
  compileFilesystemPolicy,
  buildLinuxFilesystemSandboxArgs,
  buildLinuxIsolationProbeArgs,
  linuxTrustedRuntimeReadPaths,
  probeFilesystemIsolation,
  probeNetworkIsolation,
  prepareWorkspaceProcess,
  resolveLinuxProcMode,
  runWorkspaceProcess,
} from "./processSandbox.js";

function procModeEnvironment(t: test.TestContext, mode?: string): void {
  const previous = process.env.CROWNFORGE_SANDBOX_PROC_MODE;
  if (mode === undefined) delete process.env.CROWNFORGE_SANDBOX_PROC_MODE;
  else process.env.CROWNFORGE_SANDBOX_PROC_MODE = mode;
  t.after(() => { if (previous === undefined) delete process.env.CROWNFORGE_SANDBOX_PROC_MODE; else process.env.CROWNFORGE_SANDBOX_PROC_MODE = previous; });
}

function linuxProcFixture(t: test.TestContext) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-proc-policy-")));
  const workspace = path.join(directory, "workspace"); fs.mkdirSync(workspace);
  const metadata = path.join(directory, "mountinfo");
  fs.writeFileSync(metadata, "24 1 0:22 / /proc rw - proc proc rw\n");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  const open = fs.openSync; const exists = fs.existsSync;
  t.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => Reflect.apply(open, fs, [String(file) === "/proc/self/mountinfo" ? metadata : file, ...args])) as typeof fs.openSync);
  t.mock.method(fs, "existsSync", (file: fs.PathLike) => String(file) === "/usr/bin/bwrap" || exists(file));
  if (typeof process.getuid === "function") t.mock.method(process as NodeJS.Process & { getuid: () => number }, "getuid", () => 10001);
  t.after(() => { Object.defineProperty(process, "platform", descriptor); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, metadata };
}

test("Linux proc mode is explicit, defaults to private, and rejects invalid values without spawning", (t) => {
  procModeEnvironment(t);
  assert.equal(resolveLinuxProcMode(), "private");
  assert.equal(resolveLinuxProcMode("none"), "none");
  const calls: string[] = [];
  t.mock.method(childProcess, "spawnSync", (command: string) => { calls.push(command); throw new Error("must not spawn"); });
  for (const value of ["", "automatic", "NONE", "private ", "secret-invalid-value"]) {
    process.env.CROWNFORGE_SANDBOX_PROC_MODE = value;
    assert.throws(() => resolveLinuxProcMode(), /Invalid CROWNFORGE_SANDBOX_PROC_MODE/);
    const result = probeFilesystemIsolation("linux");
    assert.equal(result.available, false); assert.equal(result.reasonCode, "invalid_configuration");
    assert.equal(result.reason?.includes("secret-invalid-value"), false);
  }
  assert.deepEqual(calls, []);
});

test("no-proc Linux argv removes only the private proc mount and keeps mandatory isolation and grants", (t) => {
  procModeEnvironment(t, "private");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-no-proc-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = compileFilesystemPolicy(root, { readPaths: ["."], writePaths: ["."] });
  const original = buildLinuxFilesystemSandboxArgs(policy, "deny", "/bin/sh", ["-c", "printf test"], policy.workspaceDir, "private");
  const none = buildLinuxFilesystemSandboxArgs(policy, "deny", "/bin/sh", ["-c", "printf test"], policy.workspaceDir, "none");
  assert.ok(Array.isArray(original)); assert.ok(Array.isArray(none));
  const withoutProc = [...original]; withoutProc.splice(withoutProc.indexOf("--proc"), 2);
  assert.deepEqual(none, withoutProc);
  for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--die-with-parent", "--new-session"]) assert.ok(none.includes(flag), flag);
  assert.equal(none.includes("/proc"), false);
  process.env.CROWNFORGE_SANDBOX_PROC_MODE = "none";
  assert.equal(buildLinuxIsolationProbeArgs().includes("--proc"), false);
  assert.equal(buildLinuxIsolationProbeArgs("deny", "private").includes("--proc"), true);
});

test("no-proc mode rejects root, proc paths, source aliases, and nested proc mounts", (t) => {
  const f = linuxProcFixture(t); procModeEnvironment(t, "none");
  const policy = compileFilesystemPolicy(f.workspace, { readPaths: ["."], writePaths: [] });
  for (const rejected of ["/", "/proc", "/proc/self", "/proc/self/exe"]) {
    assert.match(String(buildLinuxFilesystemSandboxArgs({ ...policy, readPaths: [rejected] }, "deny", "/bin/sh", [], policy.workspaceDir)), /rejects paths/);
    assert.match(String(buildLinuxFilesystemSandboxArgs(policy, "deny", rejected, [], policy.workspaceDir)), /rejects paths/);
  }
  const alias = path.join(f.directory, "root-alias"); fs.symlinkSync("/", alias);
  assert.match(String(buildLinuxFilesystemSandboxArgs({ ...policy, readPaths: [alias] }, "deny", "/bin/sh", [], policy.workspaceDir)), /rejects paths/);
  const nested = path.join(f.workspace, "proc-alias"); fs.mkdirSync(nested);
  fs.appendFileSync(f.metadata, `25 1 0:22 / ${nested} rw - proc proc rw\n`);
  assert.match(String(buildLinuxFilesystemSandboxArgs(policy, "deny", "/bin/sh", [], policy.workspaceDir)), /rejects paths/);
  fs.writeFileSync(f.metadata, "invalid metadata\n");
  assert.match(String(buildLinuxFilesystemSandboxArgs(policy, "deny", "/bin/sh", [], policy.workspaceDir)), /could not verify/);
});

test("probe and execution freeze one Linux proc mode, and a failed probe never retries another mode", (t) => {
  const f = linuxProcFixture(t); procModeEnvironment(t, "none");
  const probes: string[][] = []; let failed = false;
  t.mock.method(childProcess, "spawnSync", (_command: string, args: readonly string[]) => {
    probes.push([...args]); process.env.CROWNFORGE_SANDBOX_PROC_MODE = "private";
    return { pid: 0, output: [], stdout: "", stderr: failed ? "mount proc: Operation not permitted" : "", status: failed ? 1 : 0, signal: null };
  });
  const prepared = prepareWorkspaceProcess({ executable: "/bin/sh", args: ["-c", "printf test"], cwd: f.workspace, networkMode: "deny", filesystem: { readPaths: ["."], writePaths: [] } });
  try {
    assert.equal(probes.length, 1); assert.equal(probes[0].includes("--proc"), false);
    assert.equal(prepared.args.includes("--proc"), false);
    assert.equal(prepared.args.includes("--unshare-net"), true);
  } finally { prepared.cleanup(); }
  failed = true; probes.length = 0;
  const capability = probeFilesystemIsolation("linux");
  assert.equal(capability.available, false); assert.equal(capability.procMode, "private");
  assert.equal(probes.length, 1); assert.equal(probes[0].includes("--proc"), true);
  process.env.CROWNFORGE_SANDBOX_PROC_MODE = "none";
  assert.throws(() => prepareWorkspaceProcess({ executable: "/proc/self/exe", args: [], cwd: f.workspace, networkMode: "deny", resourceLimitMode: "posix-shell", limits: { maxOpenFiles: 64 } }), /rejects paths/);
});

test("Linux capability probes include executable runtime mounts without exposing host root or config", () => {
  const args = buildLinuxIsolationProbeArgs();
  assert.ok(args.includes("--unshare-user"));
  assert.ok(args.includes("--unshare-net"));
  assert.ok(args.includes("--unshare-pid"));
  assert.deepEqual(args.slice(-4), ["--chdir", "/tmp", "--", "/bin/true"]);
  const binds = args.flatMap((arg, index) => arg === "--ro-bind" || arg === "--bind" ? [[arg, args[index + 1], args[index + 2]]] : []);
  assert.ok(binds.some((bind) => bind[1] === "/usr"));
  assert.ok(binds.some((bind) => bind[1] === "/bin"));
  for (const forbidden of ["/", "/dev", "/app", "/app/config", "/home", "/root"]) assert.ok(binds.every((bind) => bind[1] !== forbidden), forbidden);
  assert.equal(args.filter((arg, index) => arg === "--dev" && args[index + 1] === "/dev").length, 1);
  assert.equal(buildLinuxIsolationProbeArgs("inherit").includes("--unshare-net"), false);
});

test("Linux probes distinguish namespace, mount, executable and timeout failures with bounded redacted stderr", (t) => {
  const exists = fs.existsSync;
  t.mock.method(fs, "existsSync", (candidate: fs.PathLike) => String(candidate) === "/usr/bin/bwrap" || exists(candidate));
  if (typeof process.getuid === "function") t.mock.method(process as NodeJS.Process & { getuid: () => number }, "getuid", () => 10001);
  let stderr = "";
  let error: Error | undefined;
  t.mock.method(childProcess, "spawnSync", (command: string, args: readonly string[], options: childProcess.SpawnSyncOptions) => {
    assert.equal(command, "/usr/bin/bwrap");
    assert.ok(args.includes("--ro-bind"));
    assert.ok(options.timeout && options.timeout <= 5000);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LANG: "C" });
    return { pid: 0, output: [], stdout: "", stderr, status: error ? null : 1, signal: null, error };
  });
  for (const [message, code] of [
    ["bwrap: No permissions to create a new namespace", "namespace_permission_denied"],
    ["bwrap: Failed to mount tmpfs: Operation not permitted", "mount_permission_denied"],
    ["bwrap: execvp /bin/true: No such file or directory", "runtime_unavailable"],
    ["bwrap: Creating new namespace failed: nesting depth exceeded (ENOSPC)", "namespace_limit"],
  ]) {
    stderr = message;
    const result = probeNetworkIsolation("linux");
    assert.equal(result.available, false);
    assert.equal(result.reasonCode, code);
    assert.ok(result.reason?.includes(message));
  }
  stderr = "Bearer abcdefghijklmnop sk-diagnosticCanary123456\u001b[31m " + "x".repeat(5000);
  const bounded = probeFilesystemIsolation("linux");
  assert.ok((bounded.stderr?.length || 0) <= 2048);
  assert.doesNotMatch(bounded.reason || "", /abcdefghijklmnop|diagnosticCanary|\u001b/);
  assert.match(bounded.reason || "", /REDACTED/);
  error = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  stderr = "";
  assert.equal(probeNetworkIsolation("linux").reasonCode, "probe_timeout");
});

test("Conda is exposed read-only only from the fixed root-owned runtime directory", (t) => {
  const original = fs.lstatSync;
  let mode = 0o40755;
  let uid = 0;
  let symlink = false;
  t.mock.method(fs, "lstatSync", (candidate: fs.PathLike) => {
    if (["/opt", "/opt/conda"].includes(String(candidate))) return { uid, mode, isDirectory: () => true, isSymbolicLink: () => symlink } as fs.Stats;
    return original(candidate);
  });
  assert.deepEqual(linuxTrustedRuntimeReadPaths(), ["/opt/conda"]);
  const args = buildLinuxIsolationProbeArgs();
  assert.ok(args.some((arg, index) => arg === "--ro-bind" && args[index + 1] === "/opt/conda" && args[index + 2] === "/opt/conda"));
  mode = 0o40777;
  assert.deepEqual(linuxTrustedRuntimeReadPaths(), []);
  mode = 0o40755; uid = 10001;
  assert.deepEqual(linuxTrustedRuntimeReadPaths(), []);
  uid = 0; symlink = true;
  assert.deepEqual(linuxTrustedRuntimeReadPaths(), []);
});

test("Linux bubblewrap plan mounts only system reads and declared workspace paths", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-bwrap-plan-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "read"));
  fs.mkdirSync(path.join(workspace, "write"));
  fs.mkdirSync(path.join(workspace, ".codex"));
  const policy = compileFilesystemPolicy(workspace, { readPaths: ["read"], writePaths: ["write"] });
  const args = buildLinuxFilesystemSandboxArgs(policy, "deny", "/bin/sh", ["-c", "true"], policy.workspaceDir);
  assert.ok(Array.isArray(args), String(args));
  const command = args as string[];
  assert.ok(command.includes("--unshare-net"));
  assert.deepEqual(command.slice(-4), ["--", "/bin/sh", "-c", "true"]);
  const bindTuples = command.flatMap((item, index) => item === "--bind" || item === "--ro-bind" ? [[item, command[index + 1], command[index + 2]]] : []);
  assert.ok(bindTuples.some((item) => item[0] === "--ro-bind" && item[1] === path.join(policy.workspaceDir, "read")));
  assert.ok(bindTuples.some((item) => item[0] === "--bind" && item[1] === path.join(policy.workspaceDir, "write")));
  assert.ok(bindTuples.every((item) => !String(item[1]).includes("crewforge-bwrap-outside")));
  assert.ok(command.some((item, index) => item === "--remount-ro" && command[index + 1] === path.join(policy.workspaceDir, ".codex")));
});

test("filesystem grants compile to canonical workspace paths and reject escapes", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-fs-policy-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-fs-outside-"));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "out"));
  fs.symlinkSync(outside, path.join(workspace, "escape"));

  const policy = compileFilesystemPolicy(workspace, { readPaths: ["src"], writePaths: ["out"] });
  const canonical = fs.realpathSync.native(workspace);
  assert.deepEqual(policy.readPaths, [path.join(canonical, "out"), path.join(canonical, "src")]);
  assert.deepEqual(policy.writePaths, [path.join(canonical, "out")]);
  assert.throws(() => compileFilesystemPolicy(workspace, { readPaths: ["../outside"], writePaths: [] }), /escapes workspace/i);
  assert.throws(() => compileFilesystemPolicy(workspace, { readPaths: ["escape"], writePaths: [] }), /symlink/i);
  assert.throws(() => compileFilesystemPolicy(workspace, { readPaths: ["src/**"], writePaths: [] }), /literal/i);
});

test("protected control and secret paths require exact grants", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-fs-protected-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, ".codex"));
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.writeFileSync(path.join(workspace, ".env"), "SECRET=canary\n");
  const canonical = fs.realpathSync.native(workspace);

  const broad = compileFilesystemPolicy(workspace, { readPaths: ["."], writePaths: ["."] });
  assert.ok(broad.protectedPaths.some((item) => item.path === path.join(canonical, ".codex") && item.denyRead && item.denyWrite));
  assert.ok(broad.protectedPaths.some((item) => item.path === path.join(canonical, ".env") && item.denyRead && item.denyWrite));
  const exact = compileFilesystemPolicy(workspace, { readPaths: [".", ".env"], writePaths: [".", ".codex"] });
  assert.ok(exact.protectedPaths.some((item) => item.path === path.join(canonical, ".env") && !item.denyRead && item.denyWrite));
  assert.ok(exact.protectedPaths.some((item) => item.path === path.join(canonical, ".codex") && !item.denyRead && !item.denyWrite));
});

test("filesystem isolation fails closed when this host has no hard helper", async (context) => {
  const capability = probeFilesystemIsolation();
  if (capability.available) {
    context.skip(`hard filesystem helper is available: ${capability.helper}`);
    return;
  }
  const output = await runWorkspaceProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('must not run')"],
    cwd: process.cwd(),
    filesystem: { readPaths: ["."], writePaths: ["."] },
  });
  assert.equal(output, `Error: Filesystem isolation unavailable: ${capability.reason}`);
});

test("hard filesystem helper blocks outside, secret, and control-path escapes", { skip: (() => { const capability = probeFilesystemIsolation(); return capability.available ? false : `hard filesystem isolation unavailable: ${capability.reason}`; })() }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-fs-hard-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-fs-hard-outside-"));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(workspace, "allowed"));
  fs.mkdirSync(path.join(workspace, ".codex"));
  fs.writeFileSync(path.join(workspace, "allowed", "read.txt"), "allowed");
  fs.writeFileSync(path.join(workspace, ".env"), "SECRET=canary\n");
  fs.writeFileSync(path.join(workspace, ".codex", "control.json"), "control");
  fs.writeFileSync(path.join(outside, "outside.txt"), "outside");
  const probe = `
    const fs = require("fs");
    const path = require("path");
    const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch (error) { return error.code || "DENIED"; } };
    const write = (file) => { try { fs.writeFileSync(file, "changed"); return "WROTE"; } catch (error) { return error.code || "DENIED"; } };
    process.stdout.write(JSON.stringify({
      allowedRead: read(path.join(process.cwd(), "allowed", "read.txt")),
      allowedWrite: write(path.join(process.cwd(), "allowed", "write.txt")),
      secretRead: read(path.join(process.cwd(), ".env")),
      controlWrite: write(path.join(process.cwd(), ".codex", "control.json")),
      outsideRead: read(process.argv[1]),
      outsideWrite: write(process.argv[1]),
    }));
  `;
  const output = await runWorkspaceProcess({ executable: process.execPath, args: ["-e", probe, path.join(outside, "outside.txt")], cwd: workspace, filesystem: { readPaths: ["allowed"], writePaths: ["allowed"] }, networkMode: "deny" });
  const evidence = JSON.parse(output) as Record<string, string>;
  assert.equal(evidence.allowedRead, "allowed");
  assert.equal(evidence.allowedWrite, "WROTE");
  for (const key of ["secretRead", "controlWrite", "outsideRead", "outsideWrite"]) assert.notEqual(evidence[key], "canary", key);
  assert.equal(fs.readFileSync(path.join(outside, "outside.txt"), "utf8"), "outside");
  assert.equal(fs.readFileSync(path.join(workspace, ".codex", "control.json"), "utf8"), "control");
});

test("network isolation probe reports unsupported platforms explicitly", () => {
  assert.deepEqual(probeNetworkIsolation("win32"), {
    available: false,
    reasonCode: "unsupported_platform",
    reason: "hard network deny is unsupported on platform win32",
  });
});

test("network deny fails closed when this host has no hard isolation helper", async (context) => {
  const capability = probeNetworkIsolation();
  if (capability.available) {
    context.skip(`hard network helper is available: ${capability.helper}`);
    return;
  }
  const output = await runWorkspaceProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('must not run')"],
    cwd: process.cwd(),
    networkMode: "deny",
  });
  assert.equal(output, `Error: Network isolation unavailable: ${capability.reason}`);
});

test("passes structured args verbatim without shell interpolation", async () => {
  const literal = "$(echo injected); && | <not-a-command>";
  const output = await runWorkspaceProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", literal],
    cwd: process.cwd(),
  });
  assert.equal(output, literal);
});

test("uses a minimal environment and permits explicit safe variables", async () => {
  const secretKey = "CREWFORGE_PROCESS_SANDBOX_SECRET";
  process.env[secretKey] = "must-not-leak";
  try {
    const output = await runWorkspaceProcess({
      executable: process.execPath,
      args: ["-e", `process.stdout.write([process.env.${secretKey}, process.env.EXPLICIT_VALUE].join('|'))`],
      cwd: process.cwd(),
      env: { EXPLICIT_VALUE: "present" },
    });
    assert.equal(output, "|present");
  } finally {
    delete process.env[secretKey];
  }
});

test("enforces wall-clock timeouts", async () => {
  const startedAt = Date.now();
  const output = await runWorkspaceProcess({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    cwd: process.cwd(),
    limits: { wallTimeMs: 50 },
  });
  assert.match(output, /timeout/i);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("abort terminates ordinary descendants in the detached process group", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-process-test-"));
  const marker = path.join(directory, "descendant-survived");
  const controller = new AbortController();
  try {
    const childCode = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 600)`;
    const parentCode = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); setInterval(() => {}, 10000)`;
    const pending = runWorkspaceProcess({
      executable: process.execPath,
      args: ["-e", parentCode],
      cwd: process.cwd(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    assert.match(await pending, /stopped/i);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when hard limits are requested without an explicit enforcement mode", async () => {
  const output = await runWorkspaceProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('should not run')"],
    cwd: process.cwd(),
    limits: { memoryBytes: 1_000_000 },
  });
  assert.match(output, /require resourceLimitMode "posix-shell"/i);
});

test("POSIX resource wrapper enforces an open-file hard limit", { skip: process.platform === "win32" ? "POSIX ulimit is unavailable on Windows" : false }, async () => {
  const output = await runWorkspaceProcess({
    executable: "/bin/sh",
    args: ["-c", "ulimit -H -n"],
    cwd: process.cwd(),
    limits: { maxOpenFiles: 64 },
    resourceLimitMode: "posix-shell",
  });
  assert.match(output, /^\d+$/);
  assert.ok(Number(output) <= 64, output);
});

test("open-file hard limit is reached by the executed process", { skip: process.platform === "win32" ? "POSIX ulimit is unavailable on Windows" : false }, async () => {
  const exhaustFiles = `
    const fs = require("fs");
    const descriptors = [];
    try {
      for (;;) descriptors.push(fs.openSync("/dev/null", "r"));
    } catch (error) {
      process.stdout.write(error.code || "unknown");
    }
  `;
  const output = await runWorkspaceProcess({
    executable: process.execPath,
    args: ["-e", exhaustFiles],
    cwd: process.cwd(),
    limits: { maxOpenFiles: 64 },
    resourceLimitMode: "posix-shell",
  });
  assert.match(output, /EMFILE|Too many open files/);
});

test("explicit address-space limits are enforced where supported and fail closed elsewhere", { skip: process.platform === "win32" ? "POSIX address-space limits are unavailable on Windows" : false }, async () => {
  const requestedBytes = 8 * 1024 * 1024 * 1024;
  const output = await runWorkspaceProcess({
    executable: "/bin/sh",
    args: ["-c", "ulimit -H -v"],
    cwd: process.cwd(),
    limits: { memoryBytes: requestedBytes },
    resourceLimitMode: "posix-shell",
  });
  if (process.platform === "linux") {
    assert.match(output, /^\d+$/);
    assert.ok(Number(output) <= requestedBytes / 1_024, output);
  } else {
    assert.match(output, new RegExp(`Address-space hard limits are unavailable through /bin/sh on ${process.platform}`, "i"));
  }
});

test("filesystem sandbox gives tools a private home without exposing the server home", (t) => {
  const fixture = linuxProcFixture(t); procModeEnvironment(t, "none");
  t.mock.method(childProcess, "spawnSync", (() => ({ pid: 1, output: [null, "", ""], status: 0, stdout: "", stderr: "", signal: null })) as unknown as typeof childProcess.spawnSync);
  const prepared = prepareWorkspaceProcess({ executable: "/bin/sh", args: ["-c", "printf test"], cwd: fixture.workspace,
    env: { HOME: "/server-home-must-not-be-inherited" }, networkMode: "deny",
    filesystem: { readPaths: ["."], writePaths: ["."] } });
  t.after(prepared.cleanup);
  assert.equal(prepared.env.HOME, "/tmp");
  assert.ok(prepared.args.includes("--tmpfs"));
  assert.equal(prepared.args.includes("/server-home-must-not-be-inherited"), false);
});

test("only identity-bound internal Node launches receive readonly current Frameworks through resource wrappers", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-runtime-sandbox-")));
  const workspace = path.join(root, "workspace"); const contents = path.join(root, "Fixture.app", "Contents");
  const executable = path.join(contents, "MacOS", "Fixture"); const frameworks = path.join(contents, "Frameworks");
  fs.mkdirSync(workspace); fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(frameworks); fs.writeFileSync(executable, "fixture");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!; const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const electron = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); Object.defineProperty(process, "execPath", { ...execPath, value: executable });
  Object.defineProperty(process.versions, "electron", { value: "44.4.4", configurable: true });
  if (typeof process.getuid === "function") t.mock.method(process as NodeJS.Process & { getuid: () => number }, "getuid", () => 501);
  const exists = fs.existsSync;
  t.mock.method(fs, "existsSync", (candidate: fs.PathLike) => String(candidate) === "/usr/bin/sandbox-exec" || exists(candidate));
  t.mock.method(childProcess, "spawnSync", (() => ({ pid: 1, output: [null, "", ""], status: 0, stdout: "", stderr: "", signal: null })) as unknown as typeof childProcess.spawnSync);
  t.after(() => { Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "execPath", execPath);
    if (electron) Object.defineProperty(process.versions, "electron", electron); else delete process.versions.electron;
    fs.rmSync(root, { recursive: true, force: true }); });
  const options = { executable, args: ["-e", "fixture"], cwd: workspace, filesystem: { readPaths: ["."], writePaths: [] }, networkMode: "deny" as const };
  assert.throws(() => prepareWorkspaceProcess({ ...options, env: { ELECTRON_RUN_AS_NODE: "1" } }), /blocked or invalid variable/);
  assert.throws(() => prepareWorkspaceProcess({ ...options, internalNodeRuntime: { kind: "internal-node-runtime" } }), /Internal Node runtime authority/);
  assert.throws(() => prepareWorkspaceProcess({ ...options, executable: "/bin/sh", internalNodeRuntime: INTERNAL_NODE_RUNTIME }), /Internal Node runtime authority/);
  const ordinary = prepareWorkspaceProcess(options); t.after(ordinary.cleanup);
  assert.equal(ordinary.env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(ordinary.args[1].includes(frameworks), false);
  const trusted = prepareWorkspaceProcess({ ...options, internalNodeRuntime: INTERNAL_NODE_RUNTIME, limits: { maxOpenFiles: 64 }, resourceLimitMode: "posix-shell" }); t.after(trusted.cleanup);
  const profile = trusted.args[1];
  assert.equal(trusted.args[2], "/bin/sh"); assert.equal(trusted.env.ELECTRON_RUN_AS_NODE, "1");
  assert.ok(profile.includes(`(allow file-read* (subpath ${JSON.stringify(frameworks)}) (literal ${JSON.stringify(frameworks)}))`));
  assert.equal(profile.split("\n").filter((line) => line.includes("allow file-write") && line.includes(frameworks)).length, 0);
  assert.equal(profile.includes(`(subpath ${JSON.stringify(contents)})`), false);
  assert.ok(profile.includes("(deny network*)")); assert.ok(profile.includes("(deny file-read* (subpath") && profile.includes(".codex"));
});
