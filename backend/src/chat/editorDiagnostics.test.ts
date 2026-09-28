import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { buildFileVersion } from "../files/mutationRegistry.js";
import { authMiddleware } from "../auth/middleware.js";
import { SessionManager, sessionManager, setSessionManagerForTests } from "../auth/sessionManager.js";
import { editorDiagnosticsRouter } from "../routes/editorDiagnostics.js";
import { clearEditorDiagnostics, EDITOR_DIAGNOSTIC_LIMITS, getEditorDiagnosticFeedback, publishEditorDiagnostics } from "./editorDiagnostics.js";

function fixture(t: test.TestContext) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-editor-diagnostics-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const content = "const value: number = 1;\n"; fs.writeFileSync(path.join(workspaceDir, "code.ts"), content);
  const auth = { workspaceDir, owner: "alice" };
  const body = { workspaceDir, path: "code.ts", version: buildFileVersion(content), modelVersion: 3, publisherId: "publisher", sequence: 1, dirty: false,
    diagnostics: [{ line: 1, column: 1, severity: "error", message: "Type mismatch", source: "editor:typescript", modelVersion: 3 }] };
  return { workspaceDir, auth, body };
}

test("published diagnostics remain owner/workspace scoped, redact text and are marked advisory", (t) => {
  const { workspaceDir, auth, body } = fixture(t);
  const snapshot = publishEditorDiagnostics(auth, { ...body, owner: "bob", diagnostics: [{ ...body.diagnostics[0], message: "Unexpected Bearer abcdefghijklmnop and sk-diagnosticCanary123456" }] });
  assert.equal(snapshot.provenance, "editor_advisory"); assert.equal(snapshot.baselineEligible, true);
  assert.match(snapshot.diagnostics[0].message, /REDACTED/);
  assert.doesNotMatch(snapshot.diagnostics[0].message, /abcdefghijklmnop|diagnosticCanary/);
  assert.equal(getEditorDiagnosticFeedback(auth).length, 1);
  assert.deepEqual(getEditorDiagnosticFeedback({ workspaceDir, owner: "bob" }), []);
  assert.deepEqual(getEditorDiagnosticFeedback({ workspaceDir: `${workspaceDir}-other`, owner: "alice" }), []);
});

test("dirty, stale disk and stale marker versions are rejected before storage", (t) => {
  const { workspaceDir, auth, body } = fixture(t);
  assert.throws(() => publishEditorDiagnostics(auth, { ...body, dirty: true }), /Unsaved/);
  assert.throws(() => publishEditorDiagnostics(auth, { ...body, dirty: undefined }), /Unsaved/);
  assert.throws(() => publishEditorDiagnostics(auth, { ...body, diagnostics: [{ ...body.diagnostics[0], modelVersion: 2 }] }), /older editor/);
  assert.throws(() => publishEditorDiagnostics(auth, { ...body, workspaceDir: `${workspaceDir}-old` }), /Workspace changed/);
  fs.writeFileSync(path.join(workspaceDir, "code.ts"), "const changed = 2;\n");
  assert.throws(() => publishEditorDiagnostics(auth, body), /stale disk/);
  assert.deepEqual(getEditorDiagnosticFeedback(auth), []);
});

test("consumption rechecks disk policy and version rather than trusting stored hints", (t) => {
  const { workspaceDir, auth, body } = fixture(t);
  publishEditorDiagnostics(auth, body);
  fs.writeFileSync(path.join(workspaceDir, "code.ts"), "const changed = 2;\n");
  assert.deepEqual(getEditorDiagnosticFeedback(auth), []);
  fs.writeFileSync(path.join(workspaceDir, "code.ts"), "const value: number = 1;\n");
  assert.equal(getEditorDiagnosticFeedback(auth).length, 1);
  fs.unlinkSync(path.join(workspaceDir, "code.ts"));
  fs.writeFileSync(path.join(workspaceDir, "actual.ts"), "const value: number = 1;\n");
  fs.symlinkSync(path.join(workspaceDir, "actual.ts"), path.join(workspaceDir, "code.ts"));
  assert.deepEqual(getEditorDiagnosticFeedback(auth), []);
});

test("unknown producer versions, empty lists and truncated lists never establish a classification baseline", (t) => {
  const { auth, body } = fixture(t);
  assert.equal(publishEditorDiagnostics(auth, { ...body, diagnostics: [{ ...body.diagnostics[0], modelVersion: undefined }] }).baselineEligible, false);
  assert.equal(publishEditorDiagnostics(auth, { ...body, sequence: 2, diagnostics: [] }).baselineEligible, false);
  assert.equal(publishEditorDiagnostics(auth, { ...body, sequence: 3, truncated: true }).baselineEligible, false);
  assert.equal("status" in getEditorDiagnosticFeedback(auth)[0], false);
});

test("protected paths, traversal, sensitive contents and symlinks cannot enter diagnostic feedback", (t) => {
  const { workspaceDir, auth, body } = fixture(t);
  fs.writeFileSync(path.join(workspaceDir, ".env"), "MODE=local\n");
  fs.writeFileSync(path.join(workspaceDir, "secret.ts"), "const key = 'sk-realisticCanary123456789';\n");
  fs.symlinkSync(path.join(workspaceDir, "code.ts"), path.join(workspaceDir, "link.ts"));
  for (const candidate of ["../outside.ts", ".env", ".git/config", "node_modules/index.ts", "secret.ts", "link.ts"]) {
    assert.throws(() => publishEditorDiagnostics(auth, { ...body, path: candidate }), /scope|authorized/);
  }
  assert.throws(() => publishEditorDiagnostics(auth, { ...body, diagnostics: [{ ...body.diagnostics[0], path: "other.ts" }] }), /another file/);
});

test("diagnostic count, text, position and combined byte budgets are bounded", (t) => {
  const { auth, body } = fixture(t);
  for (const diagnostics of [
    Array.from({ length: 101 }, () => body.diagnostics[0]),
    [{ ...body.diagnostics[0], message: "x".repeat(1001) }],
    [{ ...body.diagnostics[0], source: "x".repeat(121) }],
    [{ ...body.diagnostics[0], line: 99 }],
    Array.from({ length: 40 }, () => ({ ...body.diagnostics[0], message: "x".repeat(1000) })),
  ]) assert.throws(() => publishEditorDiagnostics(auth, { ...body, diagnostics }));
  assert.deepEqual(getEditorDiagnosticFeedback(auth), []);
});

test("clear tombstones reject late uploads and do not clear a different publisher", (t) => {
  const { auth, body } = fixture(t);
  publishEditorDiagnostics(auth, body);
  publishEditorDiagnostics(auth, { ...body, publisherId: "other-publisher", diagnostics: [{ ...body.diagnostics[0], message: "Other publisher" }] });
  clearEditorDiagnostics(auth, { ...body, sequence: 3 });
  assert.throws(() => publishEditorDiagnostics(auth, { ...body, sequence: 2 }), /newer editor snapshot/);
  assert.equal(getEditorDiagnosticFeedback(auth)[0].diagnostics[0].message, "Other publisher");
  clearEditorDiagnostics({ ...auth, owner: "bob" }, { ...body, publisherId: "other-publisher", sequence: 100 });
  assert.equal(getEditorDiagnosticFeedback(auth).length, 1);
  clearEditorDiagnostics(auth, { ...body, publisherId: "other-publisher", sequence: 2 });
  assert.deepEqual(getEditorDiagnosticFeedback(auth), []);
});

test("snapshots expire and read truncation cannot claim a complete baseline", (t) => {
  const { auth, body } = fixture(t);
  let now = Date.now(); const restore = Date.now; Date.now = () => now;
  try {
    publishEditorDiagnostics(auth, { ...body, diagnostics: Array.from({ length: 60 }, (_, i) => ({ ...body.diagnostics[0], message: `Issue ${i}` })) });
    const snapshot = getEditorDiagnosticFeedback(auth)[0];
    assert.equal(snapshot.diagnostics.length, EDITOR_DIAGNOSTIC_LIMITS.readDiagnostics);
    assert.equal(snapshot.truncated, true); assert.equal(snapshot.baselineEligible, false);
    now += EDITOR_DIAGNOSTIC_LIMITS.ttlMs + 1;
    assert.deepEqual(getEditorDiagnosticFeedback(auth), []);
  } finally { Date.now = restore; }
});

test("the bounded publisher store evicts oldest observations rather than retaining unlimited clients", (t) => {
  const { auth, body } = fixture(t);
  for (let i = 0; i < EDITOR_DIAGNOSTIC_LIMITS.entries + 2; i++) publishEditorDiagnostics(auth, { ...body, publisherId: `publisher-${i}` });
  for (let i = 1; i < EDITOR_DIAGNOSTIC_LIMITS.entries + 2; i++) clearEditorDiagnostics(auth, { ...body, publisherId: `publisher-${i}`, sequence: 2 });
  assert.deepEqual(getEditorDiagnosticFeedback(auth), []);
});

test("HTTP transport requires authentication and derives owner from the authenticated session", async (t) => {
  const { workspaceDir, body } = fixture(t);
  const usersPath = path.join(workspaceDir, "users.json");
  fs.writeFileSync(usersPath, JSON.stringify({ allowedRoots: [workspaceDir], users: [
    { username: "alice", password: "local-test", defaultWorkspace: workspaceDir, isAdmin: true },
    { username: "bob", password: "local-test", defaultWorkspace: workspaceDir, isAdmin: true },
  ] }));
  const originalManager = sessionManager; const manager = new SessionManager(usersPath);
  const alice = manager.login("alice", "local-test"); const bob = manager.login("bob", "local-test"); assert(alice && bob);
  const requestBody = { ...body, workspaceDir: alice.workspaceDir };
  setSessionManagerForTests(manager);
  const app = express(); app.use(express.json()); app.use("/api/editor-diagnostics", authMiddleware, editorDiagnosticsRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string"); const url = `http://127.0.0.1:${address.port}/api/editor-diagnostics`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...requestBody, owner: "bob" }) })).status, 200);
    assert.equal(((await (await fetch(url, { headers })).json()) as { snapshots: unknown[] }).snapshots.length, 1);
    assert.deepEqual(((await (await fetch(url, { headers: { Authorization: `Bearer ${bob.token}` } })).json()) as { snapshots: unknown[] }).snapshots, []);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...requestBody, sequence: 2, workspaceDir: `${workspaceDir}-other` }) })).status, 409);
    assert.equal((await fetch(url, { method: "DELETE", headers, body: JSON.stringify({ ...requestBody, sequence: 3 }) })).status, 200);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...requestBody, sequence: 2 }) })).status, 409);
  } finally { setSessionManagerForTests(originalManager); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
