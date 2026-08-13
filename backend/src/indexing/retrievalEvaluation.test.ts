import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRetrievalReferenceFixture,
  RETRIEVAL_REFERENCE_CASES,
} from "./fixtures/referenceFixture.js";
import {
  evaluateRetrievalFixture,
  RETRIEVAL_MRR_THRESHOLD,
  RETRIEVAL_RECALL_THRESHOLD,
  RETRIEVAL_SYMBOL_THRESHOLD,
} from "./retrievalEvaluation.js";

test("reference dataset contains ten deterministic cases for each retrieval category", () => {
  const categories = ["navigation", "bug_localization", "cross_file_change", "test_selection"];
  assert.equal(RETRIEVAL_REFERENCE_CASES.length, 40);
  for (const category of categories) {
    assert.equal(RETRIEVAL_REFERENCE_CASES.filter((entry) => entry.category === category).length, 10);
  }
  assert.equal(new Set(RETRIEVAL_REFERENCE_CASES.map((entry) => entry.id)).size, 40);
});

test("reference retrieval meets recall, symbol, determinism, and leak gates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-retrieval-evaluation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await evaluateRetrievalFixture({
    fixture: createRetrievalReferenceFixture(root),
    repeats: 3,
  });

  assert.equal(report.caseCount, 40);
  assert.equal(report.deterministic, true);
  assert.equal(report.forbiddenLeakCount, 0);
  assert.ok(report.overallRecall >= RETRIEVAL_RECALL_THRESHOLD, JSON.stringify(report.failures));
  for (const [category, recall] of Object.entries(report.categoryRecall)) {
    assert.ok(recall >= RETRIEVAL_RECALL_THRESHOLD, `${category}: ${recall}`);
  }
  assert.ok(report.symbolAccuracy >= RETRIEVAL_SYMBOL_THRESHOLD, `symbol accuracy: ${report.symbolAccuracy}`);
  assert.ok(report.meanReciprocalRank >= RETRIEVAL_MRR_THRESHOLD, `MRR: ${report.meanReciprocalRank}`);
  assert.equal(report.passed, true, JSON.stringify(report.failures));
});
