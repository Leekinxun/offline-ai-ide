import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { chatRouter } from "../routes/chat.js";
import { ReviewFindingStore } from "./reviewFindingStore.js";

async function serve(workspaceDir: string, isAdmin = false) {
  const app = express(); app.use(express.json());
  app.use((_req, _res, next) => { (_req as any).userSession = { workspaceDir, username: "verifier", token: "test", isAdmin }; next(); }); app.use(chatRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("review finding transition rejects stale expectedVersion atomically", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-review-routes-"));
  const store = new ReviewFindingStore(workspaceDir);
  const finding = store.ingest({ severity: "warning", path: "src/app.ts", line: 1, message: "Needs review" });
  assert.ok(finding);
  const server = await serve(workspaceDir);
  const url = `${server.base}/review-findings/${finding.id}/transition`;
  try {
    const body = { to: "accepted", expectedVersion: finding.version };
    const [first, second] = await Promise.all(["one", "two"].map(() => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })));
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const conflict = first.status === 409 ? first : second;
    assert.equal((await conflict.json() as { currentVersion: number }).currentVersion, finding.version + 1);
  } finally {
    await server.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("review finding queries filter before pagination, count, and integration status", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-review-filter-page-"));
  const historyDir = path.join(workspaceDir, ".history");
  fs.mkdirSync(historyDir, { recursive: true });
  const record = (index: number, changeSetId: string, severity: "critical" | "warning", lifecycle: "open" | "fixed" = "open") => ({
    schemaVersion: 1, id: `finding-${index}`, severity, path: `src/${index}.ts`, line: 1,
    message: `finding ${index}`, fingerprint: `fingerprint-${index}`, evidence: severity === "critical" ? ["evidence"] : [],
    lifecycle, version: 1, createdAt: index, updatedAt: index, transitions: [], changeSetId,
  });
  fs.writeFileSync(path.join(historyDir, "review-findings.json"), JSON.stringify([
    ...Array.from({ length: 510 }, (_, index) => record(index, "unrelated-change-set", "critical")),
    record(999, "requested-change-set", "critical", "fixed"),
  ]));
  const server = await serve(workspaceDir);
  try {
    const response = await fetch(`${server.base}/review-findings?changeSetId=requested-change-set&limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as { findings: Array<{ id: string; changeSetId?: string; severity: string; lifecycle: string; allowedTransitions: string[] }>; page: { total: number }; canIntegrate: boolean };
    assert.equal(body.page.total, 1);
    assert.equal(body.findings[0]?.id, "finding-999");
    assert.equal(body.findings[0]?.changeSetId, "requested-change-set");
    assert.equal(body.findings[0]?.severity, "critical");
    assert.equal(body.findings[0]?.lifecycle, "fixed");
    assert.deepEqual(body.findings[0]?.allowedTransitions, ["open"]);
    const fixedFindings = body.findings.some((finding) => finding.lifecycle === "fixed");
    const findingsAllowApply = !body.findings.some((finding) =>
      (finding.severity === "critical" || finding.severity === "error") &&
      finding.lifecycle !== "verified" && finding.lifecycle !== "dismissed"
    );
    assert.equal(fixedFindings, true, "CheckpointPanel must offer Reverify");
    assert.equal(findingsAllowApply, false, "CheckpointPanel must keep Apply disabled");
    assert.equal(body.canIntegrate, false);
    const exported = await fetch(`${server.base}/review-findings/export?changeSetId=requested-change-set`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") || "", /application\/vnd\.crewforge\.review-findings\.v1\+json/);
    assert.equal(((await exported.json()) as { findings: unknown[] }).findings.length, 1);
    const sarifResponse = await fetch(`${server.base}/review-findings/export?format=sarif&changeSetId=requested-change-set&status=fixed&severity=critical`);
    assert.equal(sarifResponse.status, 200); assert.match(sarifResponse.headers.get("content-type") || "", /application\/sarif\+json/);
    const sarif = await sarifResponse.json() as any; assert.equal(sarif.version, "2.1.0"); assert.equal(sarif.runs[0].results.length, 1); assert.equal(sarif.runs[0].tool.driver.rules[sarif.runs[0].results[0].ruleIndex].id, sarif.runs[0].results[0].ruleId); assert.deepEqual(sarif.runs[0].properties.crewforge.scope, { changeSetId: "requested-change-set", status: "fixed", severity: "critical" });
  } finally {
    await server.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("review finding routes reject malformed scoped filters", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-review-filter-invalid-"));
  const server = await serve(workspaceDir);
  try {
    for (const query of ["severity=urgent", "status=closed", "runId=", "runId=one&runId=two", "conversationId=has%20space"]) {
      assert.equal((await fetch(`${server.base}/review-findings?${query}`)).status, 400, query);
    }
    assert.equal((await fetch(`${server.base}/review-findings/export?reviewRunId=../escape`)).status, 400);
    assert.equal((await fetch(`${server.base}/review-findings/export?format=csv`)).status, 400);
  } finally {
    await server.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("review findings are append-only and critical dismissal requires an admin waiver", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-review-append-only-")); const store = new ReviewFindingStore(workspaceDir); const finding = store.ingest({ severity: "critical", path: "src/a.ts", line: 2, message: "Do not erase", evidence: ["direct evidence"] })!;
  const nonAdmin = await serve(workspaceDir, false);
  try {
    const deleted = await fetch(`${nonAdmin.base}/review-findings/${finding.id}`, { method: "DELETE" }); assert.equal(deleted.status, 405); assert.match(deleted.headers.get("allow") || "", /POST/); assert.equal(store.list().length, 1);
    const dismissed = await fetch(`${nonAdmin.base}/review-findings/${finding.id}/transition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "dismissed", expectedVersion: finding.version, reason: "waive" }) }); assert.equal(dismissed.status, 403); assert.equal(store.list()[0].lifecycle, "open");
  } finally { await nonAdmin.close(); }
  const admin = await serve(workspaceDir, true);
  try { const dismissed = await fetch(`${admin.base}/review-findings/${finding.id}/transition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "dismissed", expectedVersion: finding.version, reason: "documented admin waiver" }) }); assert.equal(dismissed.status, 200); assert.equal(store.list()[0].lifecycle, "dismissed"); assert.equal(store.list()[0].dismissalReason, "documented admin waiver"); } finally { await admin.close(); fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});
