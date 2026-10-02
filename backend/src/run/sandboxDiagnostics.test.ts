import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import express from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { createRuntimeRouter } from "../routes/runtime.js";
import { collectSandboxDiagnostics, createSandboxDiagnosticsReader, evaluateOutsideCanary, parseSandboxProcessStatus, parseSandboxSelfTestOutput, runSandboxSelfTest, type SandboxDiagnostics } from "./sandboxDiagnostics.js";

function blocked(): SandboxDiagnostics {
  const capability = { available: false, helper: "bubblewrap" as const, reasonCode: "namespace_permission_denied" as const, reason: "No permissions to create a new namespace" };
  return { checkedAt: 123, platform: "linux", kernel: "fixture", uid: 10001, gid: 10001, helperVersion: "bubblewrap 0.8.0", filesystem: capability, network: capability, executionReady: false, runtimeReadPaths: ["/opt/conda"], linux: { procMode: "private", noNewPrivs: 1, effectiveCapabilities: "0000000000000000", seccomp: 2, apparmorProfile: "docker-default (enforce)", maxUserNamespaces: 31585, unprivilegedUsernsClone: 1, apparmorRestrictUnprivilegedUserns: null } };
}

test("fixed-canary framing preserves runtime diagnostics and rejects missing, duplicate or invalid receipts", () => {
  const marker = "CREWFORGE_SANDBOX_CANARY:fixture:";
  const evidence = { allowedWrite: true, outsideWrite: false, secretRead: null, parentReachable: false };
  const receipt = marker + JSON.stringify(evidence);
  assert.deepEqual(parseSandboxSelfTestOutput(`Unsigned runtime warning\n${receipt}\n`, marker), { evidence, runtimeDiagnostics: "Unsigned runtime warning" });
  assert.deepEqual(parseSandboxSelfTestOutput(receipt, marker), { evidence });
  assert.throws(() => parseSandboxSelfTestOutput(JSON.stringify(evidence), marker), /missing or ambiguous/);
  assert.throws(() => parseSandboxSelfTestOutput(`${receipt}\n${receipt}`, marker), /missing or ambiguous/);
  assert.throws(() => parseSandboxSelfTestOutput(`${marker}[]`, marker), /receipt is invalid/);
  assert.throws(() => parseSandboxSelfTestOutput(`${marker}{invalid}`, marker));
});

test("process metadata parser exposes only bounded sandbox fields and preserves unavailable values", () => {
  assert.deepEqual(parseSandboxProcessStatus("Name:\tnode\nNoNewPrivs:\t1\nCapEff:\t0000000000000000\nSeccomp:\t2\n"), { noNewPrivs: 1, effectiveCapabilities: "0000000000000000", seccomp: 2 });
  assert.deepEqual(parseSandboxProcessStatus("NoNewPrivs: unknown\nCapEff: invalid\nSeccomp: unknown"), { noNewPrivs: null, effectiveCapabilities: null, seccomp: null });
});

test("outside canary accepts a denied write or a private scratch shadow only when the host stays hidden and unchanged", () => {
  const blocked = { outsideReadBefore: null, outsideWrite: false, outsideReadAfter: null };
  const shadow = { outsideReadBefore: null, outsideWrite: true, outsideReadAfter: "unexpected" };
  assert.deepEqual(evaluateOutsideCanary(blocked, "outside-canary"), { outsideWriteDenied: true, scratchShadowWrite: false });
  assert.deepEqual(evaluateOutsideCanary(shadow, "outside-canary"), { outsideWriteDenied: true, scratchShadowWrite: true });
  for (const evidence of [blocked, shadow]) {
    assert.equal(evaluateOutsideCanary(evidence, "unexpected").outsideWriteDenied, false, "a host mutation always fails");
    assert.equal(evaluateOutsideCanary({ ...evidence, outsideReadBefore: "outside-canary" }, "outside-canary").outsideWriteDenied, false, "read exposure fails even if the write was denied");
    assert.equal(evaluateOutsideCanary({ ...evidence, outsideReadBefore: "other visible content" }, "outside-canary").outsideWriteDenied, false);
    assert.equal(evaluateOutsideCanary({ ...evidence, outsideReadBefore: undefined }, "outside-canary").outsideWriteDenied, false, "missing evidence cannot pass");
  }
  for (const evidence of [{}, { ...shadow, outsideReadAfter: null }, { ...blocked, outsideReadAfter: "outside-canary" }, { ...shadow, outsideWrite: "true" }]) {
    assert.equal(evaluateOutsideCanary(evidence, "outside-canary").outsideWriteDenied, false);
  }
});

test("diagnostic readers cache bounded probe work and return independent snapshots", () => {
  let now = 1; let calls = 0;
  const read = createSandboxDiagnosticsReader(() => { calls += 1; return blocked(); }, () => now);
  const snapshot = read();
  snapshot.network.available = true;
  assert.equal(read().network.available, false);
  assert.equal(calls, 1);
  now += 30_001;
  read();
  assert.equal(calls, 2);
});

test("Linux diagnostics publish explicit private, none, and invalid proc modes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-proc-diagnostics-"));
  const metadata = path.join(root, "mountinfo"); fs.writeFileSync(metadata, "24 1 0:22 / /proc rw - proc proc rw\n");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previousMode = process.env.CROWNFORGE_SANDBOX_PROC_MODE;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const exists = fs.existsSync; const open = fs.openSync;
  t.mock.method(fs, "existsSync", (candidate: fs.PathLike) => String(candidate) === "/usr/bin/bwrap" || exists(candidate));
  t.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => Reflect.apply(open, fs, [String(file) === "/proc/self/mountinfo" ? metadata : file, ...args])) as typeof fs.openSync);
  if (typeof process.getuid === "function") t.mock.method(process as NodeJS.Process & { getuid: () => number }, "getuid", () => 10001);
  let probes = 0;
  t.mock.method(childProcess, "spawnSync", (_command: string, args: readonly string[]) => {
    if (!args.includes("--version")) {
      probes += 1;
      assert.equal(args.includes("--proc"), process.env.CROWNFORGE_SANDBOX_PROC_MODE !== "none");
    }
    return { pid: 0, output: [], stdout: "bubblewrap 0.8.0", stderr: "", status: 0, signal: null };
  });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    if (previousMode === undefined) delete process.env.CROWNFORGE_SANDBOX_PROC_MODE; else process.env.CROWNFORGE_SANDBOX_PROC_MODE = previousMode;
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const mode of ["private", "none"] as const) {
    process.env.CROWNFORGE_SANDBOX_PROC_MODE = mode;
    const result = collectSandboxDiagnostics();
    assert.equal(result.linux?.procMode, mode); assert.equal(result.executionReady, true);
    assert.equal(result.filesystem.procMode, mode); assert.equal(result.network.procMode, mode);
  }
  assert.equal(probes, 4);
  process.env.CROWNFORGE_SANDBOX_PROC_MODE = "invalid-config";
  const invalid = collectSandboxDiagnostics();
  assert.equal(invalid.executionReady, false); assert.equal(invalid.linux?.procMode, "invalid");
  assert.equal(invalid.filesystem.reasonCode, "invalid_configuration"); assert.equal(invalid.network.reasonCode, "invalid_configuration");
  assert.equal(probes, 4);
});

test("runtime diagnostics require an authenticated admin and accept no executable or path input", async (t) => {
  let calls = 0;
  const app = express();
  app.use("/api/runtime", (req, _res, next) => {
    const role = req.headers["x-fixture-role"];
    if (role === "admin" || role === "user") (req as typeof req & { userSession: UserSession }).userSession = { username: "fixture", isAdmin: role === "admin" } as UserSession;
    next();
  }, createRuntimeRouter(() => { calls += 1; return blocked(); }));
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { listener.closeAllConnections(); listener.close(() => resolve()); }));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/runtime/sandbox`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { "x-fixture-role": "user" } })).status, 403);
  const headers = { "x-fixture-role": "admin" };
  assert.equal((await fetch(`${url}?command=touch%20should-not-exist`, { headers })).status, 400);
  assert.equal((await fetch(`${url}?path=/app/config`, { headers })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers })).status, 404);
  assert.equal(calls, 0);
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), blocked());
  assert.equal(calls, 1);
});

test("fixed self-test uses real boundaries when available and otherwise fails closed", async () => {
  const current = collectSandboxDiagnostics();
  const result = await runSandboxSelfTest();
  if (!current.executionReady) {
    assert.equal(result.passed, false);
    assert.equal(result.checks, undefined);
    assert.match(result.error || "", /no command was run outside the sandbox/);
  } else {
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.checks?.outsideWriteDenied, true);
    assert.equal(result.checks?.parentNetworkDenied, true);
    assert.equal(result.checks?.nullDeviceWritable, true);
    assert.equal(typeof result.scratchShadowWrite, "boolean");
  }
});

test("Linux no-proc fixed canary requires proc absence and all existing boundaries", { skip: process.platform !== "linux" ? "No-proc payload requires a Linux bubblewrap host" : false }, async (t) => {
  const previous = process.env.CROWNFORGE_SANDBOX_PROC_MODE;
  process.env.CROWNFORGE_SANDBOX_PROC_MODE = "none";
  t.after(() => { if (previous === undefined) delete process.env.CROWNFORGE_SANDBOX_PROC_MODE; else process.env.CROWNFORGE_SANDBOX_PROC_MODE = previous; });
  const result = await runSandboxSelfTest();
  assert.equal(result.diagnostics.linux?.procMode, "none");
  if (!result.diagnostics.executionReady) {
    assert.equal(result.passed, false); assert.equal(result.checks, undefined);
    assert.match(result.error || "", /no command was run outside the sandbox/);
  } else {
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.checks?.payloadProcAbsent, true);
    assert.equal(result.checks?.outsideWriteDenied, true); assert.equal(result.checks?.parentNetworkDenied, true);
    assert.equal(result.checks?.allowedRead, true); assert.equal(result.checks?.allowedWrite, true);
    assert.equal(result.checks?.nullDeviceWritable, true);
  }
});
