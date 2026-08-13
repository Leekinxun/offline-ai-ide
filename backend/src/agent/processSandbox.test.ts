import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileFilesystemPolicy,
  buildLinuxFilesystemSandboxArgs,
  probeFilesystemIsolation,
  probeNetworkIsolation,
  runWorkspaceProcess,
} from "./processSandbox.js";

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
