import assert from "node:assert/strict";
import test from "node:test";
import { indexLanguageFile } from "./languageAdapters.js";

test("indexes JavaScript and TypeScript declarations with AST ranges and imports", () => {
  const result = indexLanguageFile("src/service.ts", `
// calculateTotal should not be indexed from a comment.
import { calculateTotal as importedTotal, type ServiceOptions } from "./math";
export { importedTotal as publicTotal } from "./math";

export async function calculateTotal(
  value: number,
): Promise<number> {
  return importedTotal(value);
}

export class Service {
  run(input: number) { return calculateTotal(input); }
}

export const configured = true;
const required = require("./runtime");
`);

  assert.deepEqual(
    result.symbols.filter((symbol) => ["calculateTotal", "Service", "run", "configured"].includes(symbol.name)).map((symbol) => symbol.name),
    ["calculateTotal", "Service", "run", "configured"],
  );
  assert.equal(result.symbols.find((symbol) => symbol.name === "calculateTotal")?.exported, true);
  assert.equal(result.symbols.find((symbol) => symbol.name === "configured")?.exported, true);
  assert.equal(result.symbols.find((symbol) => symbol.name === "calculateTotal")?.range.startLine, 6);
  assert.equal(result.symbols.some((symbol) => symbol.name === "calculateTotal" && symbol.range.startColumn > 1), true);

  const mathImports = result.imports.filter((entry) => entry.source === "./math");
  assert.equal(mathImports.length, 2);
  assert.equal(mathImports.some((entry) => entry.names.includes("calculateTotal") && entry.names.includes("importedTotal")), true);
  assert.equal(mathImports.some((entry) => entry.names.includes("publicTotal") && entry.names.includes("importedTotal")), true);
  assert.equal(result.imports.some((entry) => entry.source === "./runtime" && entry.names.includes("required")), true);
  assert.equal(result.references.some((entry) => entry.symbol === "importedTotal"), true);
  assert.equal(result.references.some((entry) => entry.symbol === "calculateTotal"), true);
  assert.equal(result.references.some((entry) => entry.symbol === "value" && entry.line === 12), false);
});

test("does not treat strings and comments as JavaScript or TypeScript symbols", () => {
  const result = indexLanguageFile("src/fixture.ts", `
const text = "function fake() { return false; }";
/* class Fake {} */
export const real = text;
`);

  assert.deepEqual(result.symbols.map((symbol) => symbol.name), ["text", "real"]);
  assert.equal(result.references.some((entry) => entry.symbol === "fake" || entry.symbol === "Fake"), false);
});

test("keeps non-JavaScript adapters on their original content contract", () => {
  const result = indexLanguageFile("worker.py", "def run(value):\n    return value\n");
  assert.equal(result.symbols[0]?.name, "run");
  assert.equal(result.symbols[0]?.kind, "function");
});

test("indexes local re-export aliases at the original declaration range", () => {
  const result = indexLanguageFile("src/barrel.ts", "const localName = 1;\nexport { localName as publicName };\n");
  const local = result.symbols.find((symbol) => symbol.name === "localName");
  const alias = result.symbols.find((symbol) => symbol.name === "publicName");
  assert.ok(local);
  assert.deepEqual(alias?.range, local.range);
  assert.equal(alias?.exported, true);
});
