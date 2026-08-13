import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewFindingStore, ReviewFindingStoreCorruptionError, ReviewFindingVersionConflictError } from "./reviewFindingStore.js";

test("review store dedupes, gates evidence, and blocks integration", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-review-store-"));
  const store = new ReviewFindingStore(workspace);
  assert.equal(store.ingest({ severity: "critical", path: "a.ts", line: 1, message: "bad" }, { id: "reviewer" }), null);
  const finding = store.ingest({ severity: "critical", path: "a.ts", line: 1, message: "bad", evidence: ["repro" ] }, { id: "reviewer", modelName: "m", profile: "review", revision: "r1" });
  assert.ok(finding);
  assert.equal(store.hasBlockingFindings(), true);
  assert.equal(store.ingest({ severity: "critical", path: "a.ts", line: 1, message: "bad", evidence: ["repro"] })?.id, finding.id);
  store.transition(finding.id, "accepted", { id: "writer" });
  store.transition(finding.id, "fixed", { id: "writer" }, { fixRef: "commit:1" });
  assert.throws(() => store.transition(finding.id, "verified", { id: "reviewer" }, { evidence: ["test"], revision: "r1" }), /independent review run/);
  store.transition(finding.id, "verified", { id: "verifier" }, { evidence: ["test"], revision: "r1", internalReviewRun: true });
  assert.equal(store.canIntegrate(), true);
  store.ingest({ severity: "critical", path: "a.ts", line: 1, message: "bad", evidence: ["repro"] }, { id: "reviewer", revision: "r2" });
  assert.equal(store.canIntegrate(), false);
  assert.equal(store.export().findings[0]?.transitions.length, 4);
  assert.throws(() => store.delete(finding.id), /append-only/i);
  assert.equal(store.list().some((item) => item.id === finding.id), true);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("review transitions reject stale expected versions", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-review-version-"));
  const store = new ReviewFindingStore(workspace);
  const finding = store.ingest({ severity: "warning", path: "a.ts", line: 1, message: "bad" });
  assert.ok(finding);
  store.transition(finding.id, "accepted", { id: "writer" }, { expectedVersion: 1 });
  assert.throws(() => store.transition(finding.id, "fixed", { id: "writer" }, { expectedVersion: 1 }), (error: unknown) => error instanceof ReviewFindingVersionConflictError && error.actualVersion === 2);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("reopening a fixed finding requires auditable reason or evidence", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-review-reopen-")); const store = new ReviewFindingStore(workspace); const finding = store.ingest({ severity: "warning", path: "a.ts", line: 1, message: "bad" })!; const fixed = store.transition(finding.id, "fixed", { id: "writer" }, { expectedVersion: finding.version, fixRef: "fix-revision" });
  assert.throws(() => store.transition(fixed.id, "open", { id: "operator" }, { expectedVersion: fixed.version }), /reason or evidence/i);
  const reopened = store.transition(fixed.id, "open", { id: "operator" }, { expectedVersion: fixed.version, reason: "Regression reproduced" }); assert.equal(reopened.lifecycle, "open"); assert.equal(reopened.transitions.at(-1)?.reason, "Regression reproduced");
  await fs.rm(workspace, { recursive: true, force: true });
});

test("server bindings own generic and ChangeSet finding correlation", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-review-correlation-"));
  const store = new ReviewFindingStore(workspace);
  const generic = store.ingest({
    severity: "warning", path: "a.ts", line: 2, message: "generic",
    runId: "spoofed-run", conversationId: "spoofed-conversation",
    changeSetId: "spoofed-change-set", reviewRunId: "spoofed-review-run",
  }, { id: "reviewer" }, { runId: "run-server", conversationId: "conversation-server" });
  assert.ok(generic);
  assert.equal(generic.runId, "run-server");
  assert.equal(generic.conversationId, "conversation-server");
  assert.equal(generic.changeSetId, undefined);
  assert.equal(generic.reviewRunId, undefined);

  const first = store.ingest({ severity: "warning", path: "same.ts", line: 3, message: "scoped" }, {
    id: "reviewer-1", changeSetId: "change-1", reviewRunId: "review-run-1",
  });
  const second = store.ingest({ severity: "warning", path: "same.ts", line: 3, message: "scoped" }, {
    id: "reviewer-2", changeSetId: "change-1", reviewRunId: "review-run-2",
  });
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(store.list({ changeSetId: "change-1", reviewRunId: "review-run-1" }).map((item) => item.id), [first.id]);
  assert.deepEqual(store.list({ changeSetId: "change-1", reviewRunId: "review-run-2" }).map((item) => item.id), [second.id]);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("missing and legacy review stores remain compatible", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-review-legacy-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new ReviewFindingStore(workspace);
  assert.deepEqual(store.list(), []);
  assert.equal(store.canIntegrate(), true);

  const finding = store.ingest({ severity: "warning", path: "legacy.ts", line: 1, message: "legacy" });
  assert.ok(finding);
  const target = path.join(workspace, ".history", "review-findings.json");
  const records = JSON.parse(await fs.readFile(target, "utf8")) as Array<Record<string, unknown>>;
  delete records[0].schemaVersion;
  await fs.writeFile(target, `${JSON.stringify(records)}\n`);
  assert.equal(new ReviewFindingStore(workspace).list()[0]?.schemaVersion, 1);
});

test("existing corrupt and future-schema review stores fail closed without rewriting source", async (t) => {
  for (const [label, source] of [
    ["corrupt", "{not-json\n"],
    ["future", `${JSON.stringify([{ schemaVersion: 2, severity: "critical", path: "a.ts", line: 1, message: "must not disappear", evidence: ["proof"] }])}\n`],
  ] as const) {
    await t.test(label, async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `crewforge-review-${label}-`));
      try {
        const target = path.join(workspace, ".history", "review-findings.json");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, source);
        assert.throws(() => new ReviewFindingStore(workspace).canIntegrate(), ReviewFindingStoreCorruptionError);
        assert.equal(await fs.readFile(target, "utf8"), source);
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });
  }
});

test("unreadable review store paths fail closed and remain untouched", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-review-unreadable-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const target = path.join(workspace, ".history", "review-findings.json");
  await fs.mkdir(target, { recursive: true });
  assert.throws(() => new ReviewFindingStore(workspace).list(), ReviewFindingStoreCorruptionError);
  assert.equal((await fs.lstat(target)).isDirectory(), true);
});
