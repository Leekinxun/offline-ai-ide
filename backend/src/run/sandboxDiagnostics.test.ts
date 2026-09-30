import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { createRuntimeRouter } from "../routes/runtime.js";
import { collectSandboxDiagnostics, createSandboxDiagnosticsReader, parseSandboxProcessStatus, runSandboxSelfTest, type SandboxDiagnostics } from "./sandboxDiagnostics.js";

function blocked(): SandboxDiagnostics {
  const capability = { available: false, helper: "bubblewrap" as const, reasonCode: "namespace_permission_denied" as const, reason: "No permissions to create a new namespace" };
  return { checkedAt: 123, platform: "linux", kernel: "fixture", uid: 10001, gid: 10001, helperVersion: "bubblewrap 0.8.0", filesystem: capability, network: capability, executionReady: false, runtimeReadPaths: ["/opt/conda"], linux: { noNewPrivs: 1, effectiveCapabilities: "0000000000000000", seccomp: 2, apparmorProfile: "docker-default (enforce)", maxUserNamespaces: 31585, unprivilegedUsernsClone: 1, apparmorRestrictUnprivilegedUserns: null } };
}

test("process metadata parser exposes only bounded sandbox fields and preserves unavailable values", () => {
  assert.deepEqual(parseSandboxProcessStatus("Name:\tnode\nNoNewPrivs:\t1\nCapEff:\t0000000000000000\nSeccomp:\t2\n"), { noNewPrivs: 1, effectiveCapabilities: "0000000000000000", seccomp: 2 });
  assert.deepEqual(parseSandboxProcessStatus("NoNewPrivs: unknown\nCapEff: invalid\nSeccomp: unknown"), { noNewPrivs: null, effectiveCapabilities: null, seccomp: null });
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
  }
});
