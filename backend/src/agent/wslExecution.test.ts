import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { __wslExecutionForTests, prepareWslWorkspaceProcess, probeWslExecution, setWslExecutionTestHooks } from "./wslExecution.js";
import { __wslHelperForTests } from "./wslHelper.js";

function fixture(t: test.TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-wsl-test-")));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const temp = path.join(root, "control");
  const helper = path.join(outside, "backend", "dist", "agent", "wslHelper.js");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "alpha.txt"), "probe");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.mkdirSync(temp);
  fs.writeFileSync(helper, "helper");
  t.after(() => {
    setWslExecutionTestHooks(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, outside, temp, helper };
}

function installWslPathMock(_t: test.TestContext, helper: string, temp: string, extra?: { probe?: "ready" | "failed" }) {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  setWslExecutionTestHooks({
    platform: "win32",
    helperHostPath: helper,
    wslExecutablePath: "C:\\Windows\\System32\\wsl.exe",
    tempRoot: temp,
    env: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: "C:\\Windows\\System32;C:\\leaky-bin",
      NODE_OPTIONS: "--require should-not-leak",
      SECRET_TOKEN: "must-not-leak",
    },
    setInterval: ((callback: () => void) => {
      const handle = setInterval(callback, 10);
      return handle;
    }) as typeof setInterval,
    setTimeout: ((callback: () => void, ms?: number) => {
      const handle = setTimeout(callback, ms);
      return handle;
    }) as typeof setTimeout,
    spawnSync: ((command: string, args: readonly string[], options: childProcess.SpawnSyncOptions) => {
      calls.push({ command, args: [...args], env: options.env as NodeJS.ProcessEnv });
      if (command.endsWith("\\powershell.exe")) {
        assert.equal((options.env as NodeJS.ProcessEnv).CROWNFORGE_WSL_CASE_DIR?.includes("workspace"), true);
        assert.equal(args.includes("-EncodedCommand"), true);
        return { pid: 1, output: [], stdout: "1", stderr: "", status: 0, signal: null };
      }
      if (args.includes("/usr/bin/wslpath")) {
        const windowsPath = String(args[args.length - 1]);
        return { pid: 1, output: [], stdout: `/mnt/host/${windowsPath.replaceAll("\\", "/")}\n`, stderr: "", status: 0, signal: null };
      }
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    }) as unknown as typeof childProcess.spawnSync,
    spawn: ((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      calls.push({ command, args: [...args], env: options.env as NodeJS.ProcessEnv });
      return fakeSpawn(extra?.probe === "failed"
        ? { stdout: JSON.stringify({ available: false, executor: "wsl", reasonCode: "isolation_unavailable", reason: "bwrap denied" }), code: 125 }
        : { stdout: JSON.stringify({ available: true, executor: "wsl", reasonCode: "ready" }), code: 0 });
    }) as unknown as typeof childProcess.spawn,
  });
  return calls;
}

function fakeSpawn(result: { stdout?: string; stderr?: string; code?: number; signal?: NodeJS.Signals | null }): childProcess.ChildProcess {
  const child = new EventEmitter() as childProcess.ChildProcess;
  Object.defineProperty(child, "pid", { value: 12345 });
  child.stdin = new PassThrough() as childProcess.ChildProcess["stdin"];
  child.stdout = new PassThrough() as childProcess.ChildProcess["stdout"];
  child.stderr = new PassThrough() as childProcess.ChildProcess["stderr"];
  child.kill = (() => true) as childProcess.ChildProcess["kill"];
  process.nextTick(() => {
    if (result.stdout) child.stdout?.emit("data", Buffer.from(result.stdout));
    if (result.stderr) child.stderr?.emit("data", Buffer.from(result.stderr));
    child.emit("close", result.code ?? 0, result.signal ?? null);
  });
  return child;
}

function readOnlyManifest(temp: string) {
  const [directory] = fs.readdirSync(temp).filter((entry) => entry.startsWith("crewforge-wsl-"));
  assert.ok(directory);
  const manifestPath = path.join(temp, directory, "manifest.json");
  return { manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown> };
}

test("prepareWslWorkspaceProcess writes a manifest and keeps shell source out of the bootstrap argv", (t) => {
  const f = fixture(t);
  const calls = installWslPathMock(t, f.helper, f.temp);
  fs.writeFileSync(path.join(f.workspace, "wsl.exe"), "malicious");
  const command = "printf '%s' \"$(echo not-in-bootstrap)\" && echo done";
  const prepared = prepareWslWorkspaceProcess({
    executable: "/bin/bash",
    args: ["-c", command],
    cwd: f.workspace,
    env: { EXPLICIT_VALUE: "present" },
    networkMode: "deny",
    resourceLimitMode: "posix-shell",
    limits: { maxOpenFiles: 64, wallTimeMs: 1234 },
    filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: ["."] },
  });
  t.after(prepared.cleanup);
  assert.equal(prepared.executable, "C:\\Windows\\System32\\wsl.exe");
  assert.equal(calls.some((call) => call.command === path.join(f.workspace, "wsl.exe")), false);
  assert.deepEqual(prepared.args.slice(0, 4), ["--exec", "/usr/bin/env", "-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]);
  assert.equal(prepared.args.includes(command), false);
  assert.equal(prepared.env.NODE_OPTIONS, undefined);
  assert.equal(prepared.env.SECRET_TOKEN, undefined);
  assert.ok(prepared.env.PATH?.startsWith("C:\\Windows\\System32"));

  const { manifest } = readOnlyManifest(f.temp);
  const options = manifest.options as { args: string[]; env: Record<string, string>; executable: string; limits: Record<string, number> };
  assert.equal(options.executable, "/bin/bash");
  assert.deepEqual(options.args, ["-c", command]);
  assert.deepEqual(options.env, { EXPLICIT_VALUE: "present" });
  assert.equal(options.limits.maxOpenFiles, 64);
  assert.equal(calls.every((call) => !String(call.env?.NODE_OPTIONS || "").includes("should-not-leak")), true);
});

test("cleanup writes a stop control marker and delays removing helper state for WSL cleanup", (t) => {
  const f = fixture(t);
  installWslPathMock(t, f.helper, f.temp);
  const prepared = prepareWslWorkspaceProcess({
    executable: "/bin/bash",
    args: ["-c", "sleep 30"],
    cwd: f.workspace,
    filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: ["."] },
  });
  const { manifestPath, manifest } = readOnlyManifest(f.temp);
  const controlPath = (manifest as { controlPath: string }).controlPath;
  prepared.cleanup();
  const control = JSON.parse(fs.readFileSync(controlPath, "utf8")) as { stop: boolean };
  assert.equal(control.stop, true);
  assert.equal(fs.existsSync(manifestPath), true);
});

test("WSL probe reports missing wsl.exe with an actionable install message", async (t) => {
  const f = fixture(t);
  setWslExecutionTestHooks({
    platform: "win32",
    helperHostPath: f.helper,
    wslExecutablePath: "C:\\Windows\\System32\\wsl.exe",
    tempRoot: f.temp,
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    spawnSync: (() => ({ pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) })) as unknown as typeof childProcess.spawnSync,
  });
  const capability = await probeWslExecution();
  assert.equal(capability.available, false);
  assert.equal(capability.reasonCode, "wsl_missing");
  assert.match(capability.reason || "", /wsl --install/i);
});

test("WSL probe caches bounded helper checks for 30 seconds", async (t) => {
  const f = fixture(t);
  let time = 1_000;
  const calls = installWslPathMock(t, f.helper, f.temp, { probe: "ready" });
  setWslExecutionTestHooks({
    platform: "win32",
    helperHostPath: f.helper,
    wslExecutablePath: "C:\\Windows\\System32\\wsl.exe",
    tempRoot: f.temp,
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    now: () => time,
    spawnSync: ((command: string, args: readonly string[], options: childProcess.SpawnSyncOptions) => {
      calls.push({ command, args: [...args], env: options.env as NodeJS.ProcessEnv });
      if (command.endsWith("\\powershell.exe")) return { pid: 1, output: [], stdout: "1", stderr: "", status: 0, signal: null };
      if (args.includes("/usr/bin/wslpath")) return { pid: 1, output: [], stdout: `/mnt/host/${String(args.at(-1)).replaceAll("\\", "/")}\n`, stderr: "", status: 0, signal: null };
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    }) as unknown as typeof childProcess.spawnSync,
    spawn: ((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      calls.push({ command, args: [...args], env: options.env as NodeJS.ProcessEnv });
      return fakeSpawn({ stdout: JSON.stringify({ available: true, executor: "wsl", reasonCode: "ready" }), code: 0 });
    }) as unknown as typeof childProcess.spawn,
  });
  assert.equal((await probeWslExecution()).available, true);
  assert.equal((await probeWslExecution()).available, true);
  assert.equal(calls.filter((call) => call.args.includes("/usr/bin/node")).length, 1);
  time += 31_000;
  assert.equal((await probeWslExecution()).available, true);
  assert.equal(calls.filter((call) => call.args.includes("/usr/bin/node")).length, 2);
  assert.equal((await probeWslExecution({ refresh: true })).available, true);
  assert.equal(calls.filter((call) => call.args.includes("/usr/bin/node")).length, 3);
});

test("checking again recovers from a missing WSL installation before cache expiry", async (t) => {
  const f = fixture(t);
  let installed = false;
  setWslExecutionTestHooks({
    platform: "win32", helperHostPath: f.helper, tempRoot: f.temp,
    env: { SystemRoot: "C:\\Windows" },
    spawnSync: ((_command: string, args: readonly string[]) => installed
      ? { pid: 1, output: [], stdout: `/mnt/host/${String(args.at(-1)).replaceAll("\\", "/")}\n`, stderr: "", status: 0, signal: null }
      : { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }) as unknown as typeof childProcess.spawnSync,
    spawn: (() => fakeSpawn({ stdout: JSON.stringify({ available: true, executor: "wsl", reasonCode: "ready" }), code: 0 })) as unknown as typeof childProcess.spawn,
  });
  assert.equal((await probeWslExecution()).available, false);
  installed = true;
  assert.equal((await probeWslExecution()).available, false);
  const refreshed = await probeWslExecution({ refresh: true });
  assert.equal(refreshed.available, true);
  refreshed.available = false;
  assert.equal((await probeWslExecution()).available, true);
});

test("a missing Linux Node interpreter reports its dependency rather than a generic WSL failure", () => {
  const result = __wslExecutionForTests.classifyWslProcessFailure("/usr/bin/env: /usr/bin/node: No such file or directory", undefined, 127, null);
  assert.equal(result.available, false);
  assert.equal(result.reasonCode, "node_missing");
});

test("host validation fails closed for control roots, symlink grants, invalid env, and case-masked protected paths", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "grant-outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.workspace, "escape"));
  installWslPathMock(t, f.helper, f.workspace);
  assert.throws(() => prepareWslWorkspaceProcess({
    executable: "/bin/bash", args: ["-c", "true"], cwd: f.workspace,
    filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: ["."] },
  }), /control directory.*outside Agent filesystem grants/);

  installWslPathMock(t, f.helper, f.temp);
  assert.throws(() => prepareWslWorkspaceProcess({
    executable: "/bin/bash", args: ["-c", "true"], cwd: f.workspace,
    filesystem: { workspaceDir: f.workspace, readPaths: ["escape"], writePaths: [] },
  }), /symlink/);
  assert.throws(() => prepareWslWorkspaceProcess({
    executable: "/bin/bash", args: ["-c", "true"], cwd: f.workspace,
    env: { NODE_OPTIONS: "--require injected" },
    filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: [] },
  }), /blocked or invalid/);
  fs.mkdirSync(path.join(f.workspace, ".GIT"));
  assert.throws(() => prepareWslWorkspaceProcess({
    executable: "/bin/bash", args: ["-c", "true"], cwd: f.workspace,
    filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: [] },
  }), /case-ambiguous/);
});

test("Linux helper converts Windows grants, rejects grant escapes, and preserves bash -c as argv", { skip: process.platform === "win32" ? "Linux helper filesystem checks run inside WSL, not Windows Node" : false }, (t) => {
  const f = fixture(t);
  const manifestPath = path.join(f.outside, "manifest.json");
  const controlPath = path.join(f.outside, "control.json");
  fs.writeFileSync(controlPath, "{}");
  const originalSpawnSync = childProcess.spawnSync;
  fs.writeFileSync(manifestPath, "{}");
  t.mock.method(childProcess, "spawnSync", ((command: string, args: readonly string[]) => {
    assert.equal(command, "/usr/bin/wslpath");
    return { pid: 1, output: [], stdout: `${String(args.at(-1))}\n`, stderr: "", status: 0, signal: null };
  }) as unknown as typeof childProcess.spawnSync);
  t.after(() => { childProcess.spawnSync = originalSpawnSync; });
  const command = "echo $(should-stay-literal)";
  const compiled = __wslHelperForTests.compileLinuxOptions({
    version: 1,
    op: "execute",
    controlPath,
    options: {
      executable: "/bin/bash",
      args: ["-c", command],
      cwd: f.workspace,
      env: {},
      networkMode: "deny",
      hostCaseSensitiveWorkspace: true,
      filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: [] },
    },
  }, manifestPath);
  assert.equal(compiled.executable, "/bin/bash");
  assert.deepEqual(compiled.args, ["-c", command]);
  assert.equal(compiled.cwd, f.workspace);

  assert.throws(() => __wslHelperForTests.compileLinuxOptions({
    version: 1,
    op: "execute",
    controlPath,
    options: {
      executable: "/bin/bash",
      args: [],
      cwd: f.workspace,
      env: {},
      hostCaseSensitiveWorkspace: true,
      filesystem: { workspaceDir: f.workspace, readPaths: [".."], writePaths: [] },
      networkMode: "deny",
    },
  }, manifestPath), /escapes workspace/);
});

test("dev source without a built dist helper fails clearly instead of downloading tsx in WSL", (t) => {
  const f = fixture(t);
  const missing = path.join(f.outside, "backend", "dist", "agent", "missingHelper.js");
  setWslExecutionTestHooks({ platform: "win32", helperHostPath: missing, tempRoot: f.temp });
  assert.throws(() => prepareWslWorkspaceProcess({
    executable: "/bin/bash",
    args: ["-c", "true"],
    cwd: f.workspace,
  }), /npm run build/);
});

test("minimal host and manifest environments do not inherit Windows PATH, NODE injection, or secrets", (t) => {
  const f = fixture(t);
  installWslPathMock(t, f.helper, f.temp);
  const prepared = prepareWslWorkspaceProcess({
    executable: "/bin/bash",
    args: ["-c", "env"],
    cwd: f.workspace,
    env: { SAFE_FLAG: "1" },
    filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: [] },
  });
  t.after(prepared.cleanup);
  const { manifest } = readOnlyManifest(f.temp);
  const options = manifest.options as { env: Record<string, string> };
  assert.deepEqual(options.env, { SAFE_FLAG: "1" });
  assert.equal(JSON.stringify(manifest).includes("SECRET_TOKEN"), false);
  assert.equal(prepared.args.includes("PATH=C:\\leaky-bin"), false);
});

test("host manifest helper seam rejects workspace placement before launching WSL", (t) => {
  const f = fixture(t);
  const localHelper = path.join(f.workspace, "backend", "dist", "agent", "wslHelper.js");
  fs.mkdirSync(path.dirname(localHelper), { recursive: true });
  fs.writeFileSync(localHelper, "helper");
  installWslPathMock(t, localHelper, f.temp);
  assert.throws(() => prepareWslWorkspaceProcess({
    executable: "/bin/bash",
    args: ["-c", "true"],
    cwd: f.workspace,
    filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: [] },
  }), /trusted backend runtime must live outside Agent filesystem grants/);
});

test("host pure manifest helper keeps cwd inside workspace", (t) => {
  const f = fixture(t);
  installWslPathMock(t, f.helper, f.temp);
  const outside = path.join(f.root, "outside-cwd");
  fs.mkdirSync(outside);
  assert.throws(() => __wslExecutionForTests.prepareManifest({
    executable: "/bin/bash",
    args: ["-c", "true"],
    cwd: outside,
    filesystem: { workspaceDir: f.workspace, readPaths: ["."], writePaths: [] },
  }, path.join(f.temp, "control.json")), /cwd escapes/);
});

test("host manifest serializes nested Windows grants as POSIX relative paths", () => {
  assert.equal(__wslExecutionForTests.posixRelative("C:\\repo", "C:\\repo\\nested\\dir"), "nested/dir");
});

test("Linux helper fails closed when workspace case sensitivity cannot be verified read-only", { skip: process.platform === "win32" ? "Linux helper filesystem checks run inside WSL, not Windows Node" : false }, (t) => {
  const f = fixture(t);
  const emptyWorkspace = path.join(f.root, "empty-workspace");
  fs.mkdirSync(emptyWorkspace);
  const manifestPath = path.join(f.outside, "manifest-empty.json");
  const controlPath = path.join(f.outside, "control-empty.json");
  fs.writeFileSync(manifestPath, "{}");
  fs.writeFileSync(controlPath, "{}");
  t.mock.method(childProcess, "spawnSync", ((command: string, args: readonly string[]) => {
    assert.equal(command, "/usr/bin/wslpath");
    return { pid: 1, output: [], stdout: `${String(args.at(-1))}\n`, stderr: "", status: 0, signal: null };
  }) as unknown as typeof childProcess.spawnSync);
  assert.throws(() => __wslHelperForTests.compileLinuxOptions({
    version: 1,
    op: "execute",
    controlPath,
    options: {
      executable: "/bin/bash",
      args: [],
      cwd: emptyWorkspace,
      env: {},
      networkMode: "deny",
      filesystem: { workspaceDir: emptyWorkspace, readPaths: ["."], writePaths: [] },
    },
  }, manifestPath), /case sensitivity could not be verified/);
});

test("Linux helper accepts an empty workspace when the Windows host proved case sensitivity", { skip: process.platform === "win32" ? "Linux helper filesystem checks run inside WSL, not Windows Node" : false }, (t) => {
  const f = fixture(t);
  const emptyWorkspace = path.join(f.root, "empty-proved-workspace");
  fs.mkdirSync(emptyWorkspace);
  const manifestPath = path.join(f.outside, "manifest-proved.json");
  const controlPath = path.join(f.outside, "control-proved.json");
  fs.writeFileSync(manifestPath, "{}");
  fs.writeFileSync(controlPath, "{}");
  t.mock.method(childProcess, "spawnSync", ((command: string, args: readonly string[]) => {
    assert.equal(command, "/usr/bin/wslpath");
    return { pid: 1, output: [], stdout: `${String(args.at(-1))}\n`, stderr: "", status: 0, signal: null };
  }) as unknown as typeof childProcess.spawnSync);
  const compiled = __wslHelperForTests.compileLinuxOptions({
    version: 1,
    op: "execute",
    controlPath,
    options: {
      executable: "/bin/bash",
      args: [],
      cwd: emptyWorkspace,
      env: {},
      hostCaseSensitiveWorkspace: true,
      filesystem: { workspaceDir: emptyWorkspace, readPaths: ["."], writePaths: [] },
      networkMode: "deny",
    },
  }, manifestPath);
  assert.equal(compiled.cwd, emptyWorkspace);
});
