import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require(path.join(root, "frontend/node_modules/typescript/lib/typescript.js"));
const source = fs.readFileSync(path.join(root, "frontend/src/components/fileTreeKeyboardContract.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
new Function("module", "exports", compiled)(module, module.exports);
const { resolveVisibleTreeIndex } = module.exports;

const cases = [
  [0, 3, "ArrowDown", 1],
  [2, 3, "ArrowDown", 2],
  [1, 3, "ArrowUp", 0],
  [0, 3, "ArrowUp", 0],
  [2, 3, "Home", 0],
  [0, 3, "End", 2],
  [0, 0, "Home", null],
  [0, 3, "Enter", null],
];
for (const [current, count, key, expected] of cases) {
  const actual = resolveVisibleTreeIndex(current, count, key);
  if (actual !== expected) throw new Error(`${key}: expected ${expected}, received ${actual}`);
}
console.log("CrewForge file-tree keyboard contract passed.");
