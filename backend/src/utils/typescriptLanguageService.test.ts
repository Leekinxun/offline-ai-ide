import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { findTypeScriptDefinition, findTypeScriptReferences, getTypeScriptLanguageServiceMetrics, warmTypeScriptLanguageService } from "./typescriptLanguageService.js";

function workspace(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-ts-language-service-"));
  fs.mkdirSync(path.join(root, "src"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("resolves aliased TypeScript definitions with the compiler language service", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "src", "service.ts"), "export function calculateTotal(value: number) { return value + 1; }\n");
  fs.writeFileSync(path.join(root, "src", "consumer.ts"), "import { calculateTotal as sum } from './service';\nexport const result = sum(2);\n");

  const location = findTypeScriptDefinition(root, "src/consumer.ts", "sum");
  assert.equal(location?.path, "src/service.ts");
  assert.equal(location?.selection.startLine, 1);
  assert.equal(location?.selection.startColumn, 17);
});

test("returns semantic references across TypeScript files", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "src", "service.ts"), "export function calculateTotal(value: number) { return value + 1; }\n");
  fs.writeFileSync(path.join(root, "src", "consumer.ts"), "import { calculateTotal } from './service';\nexport const result = calculateTotal(2);\n");

  const references = findTypeScriptReferences(root, "src/service.ts", "calculateTotal");
  assert.equal(references.some((entry) => entry.path === "src/consumer.ts" && entry.selection.startLine === 2), true);
  assert.equal(references.some((entry) => entry.path === "src/service.ts" && entry.selection.startLine === 1), true);
});

test("honors ripgrep ignore files when warming the semantic host", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".ignore"), "src/ignored.ts\n");
  fs.writeFileSync(path.join(root, "src", "ignored.ts"), "export function ignoredSymbol() {}\n");
  fs.writeFileSync(path.join(root, "src", "consumer.ts"), "import { ignoredSymbol } from './ignored';\nignoredSymbol();\n");

  assert.notEqual(findTypeScriptDefinition(root, "src/consumer.ts", "ignoredSymbol")?.path, "src/ignored.ts");
});

test("records warm-up and lookup metrics", (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "src", "service.ts"), "export const value = 1;\n");
  warmTypeScriptLanguageService(root);
  const cold = getTypeScriptLanguageServiceMetrics(root);
  assert.equal(cold.status, "ready");
  assert.equal(cold.indexedFiles, 1);
  assert.equal(cold.cacheMisses >= 1, true);
  findTypeScriptDefinition(root, "src/service.ts", "value");
  const warm = getTypeScriptLanguageServiceMetrics(root);
  assert.equal(warm.lookups >= 1, true);
  assert.equal(warm.cacheHits >= 1, true);
});
