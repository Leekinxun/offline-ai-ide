import assert from "node:assert/strict";
import test from "node:test";
import { contextRequestBudget, fitsContextRequestBudget } from "./contextBudget.js";

test("request budgets reserve schemas, instructions, retrieval, and output", () => {
  const input = { threshold: 60_000, systemPrompt: "instruction ".repeat(1000), tools: [], maxOutputTokens: 8_192 };
  const budget = contextRequestBudget(input);
  assert.ok(budget.historyTarget < 48_000);
  assert.equal(budget.retrievalReserve, 6_000);
  assert.ok(fitsContextRequestBudget({ ...input, messages: [{ role: "user", content: "x".repeat(budget.historyTarget * 4 - 100) }] }, budget.requestLimit));
  assert.equal(fitsContextRequestBudget({ ...input, messages: [{ role: "user", content: "x".repeat(60_000 * 4) }] }, budget.requestLimit), false);
});

test("full requests include Unicode and tool schemas even when history is small", () => {
  const input = { systemPrompt: "目标与约束".repeat(300), tools: [{ type: "function" as const, function: { name: "fixture", description: "x".repeat(5000), parameters: {} } }], maxOutputTokens: 500 };
  assert.equal(fitsContextRequestBudget({ ...input, messages: [] }, 1000), false);
  assert.throws(() => contextRequestBudget({ ...input, threshold: 1000 }), /cannot fit/);
});
