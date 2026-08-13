import assert from "node:assert/strict";
import test from "node:test";
import { runRetrievalBenchmark } from "./retrievalBenchmark.js";

test(
  "smoke repository indexing remains inside cold, incremental, query, and memory budgets",
  { skip: process.env.CREWFORGE_RUN_RETRIEVAL_BENCHMARK !== "1", timeout: 60_000 },
  async () => {
    const report = await runRetrievalBenchmark({ profile: "smoke" });
    assert.equal(report.scale.files, 2_000);
    assert.equal(report.scale.lines, 200_000);
    assert.equal(report.incremental.filesScannedMax <= 1, true);
    assert.equal(report.incremental.unrelatedPartitionChanges, 0);
    assert.equal(report.passed, true, JSON.stringify(report.failures));
  }
);
