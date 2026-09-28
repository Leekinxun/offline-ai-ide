import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchContextSymbols } from "./contextSymbols.js";
import { resolveContextReferences } from "./contextReferences.js";

test("live symbol candidates carry authorized file, exact declaration range and version into the context manifest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-symbol-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "feature.ts"), "export function processWidget(value: number) {\n  return value + 1;\n}\nexport const widgetSize = 4;\n");
  const { symbols } = await searchContextSymbols(root, "Widget");
  const selected = symbols.find((symbol) => symbol.symbol === "processWidget");
  assert.ok(selected);
  assert.equal(selected.path, "feature.ts");
  assert.equal(selected.range.startLine, 1);
  const context = resolveContextReferences(root, [selected]);
  assert.match(context.items[0].content, /return value \+ 1/);
  assert.equal(context.items[0].source.sourceType, "explicit_symbol_reference");
  assert.equal(context.items[0].source.revision, selected.version);
  assert.throws(() => resolveContextReferences(root, [{ ...selected, range: { ...selected.range, startColumn: 1 } }]), /source range/);
  fs.appendFileSync(path.join(root, "feature.ts"), "// newer version\n");
  assert.throws(() => resolveContextReferences(root, [selected]), /Symbol source changed/);
});

test("symbol lookup omits credentials, generated content and symlink escapes and bounds its results", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-symbol-bounds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "secret.ts"), 'const password = "protected123456"; export function hiddenWidget() {}');
  fs.writeFileSync(path.join(root, "generated.ts"), "// @generated\nexport function generatedWidget() {}\n");
  fs.writeFileSync(path.join(root, "normal.ts"), Array.from({ length: 40 }, (_, i) => `export function widget${i}() {}`).join("\n"));
  fs.symlinkSync(path.join(root, "normal.ts"), path.join(root, "alias.ts"));
  const result = await searchContextSymbols(root, "widget");
  assert.ok(result.symbols.length <= 30);
  assert.equal(result.truncated, true);
  assert.ok(result.symbols.every((symbol) => symbol.path === "normal.ts"));
  assert.deepEqual(await searchContextSymbols(root, "w"), { symbols: [], truncated: false });
});
