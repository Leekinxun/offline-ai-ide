import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require(path.join(root, "frontend/node_modules/typescript/lib/typescript.js"));
const source = fs.readFileSync(path.join(root, "frontend/src/components/modalKeyboardContract.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
new Function("module", "exports", compiled)(module, module.exports);
const { claimModalEscape } = module.exports;

let childClosed = 0;
let parentClosed = 0;
let immediateStopped = false;
const event = {
  key: "Escape",
  preventDefault() {},
  stopPropagation() {},
  stopImmediatePropagation() { immediateStopped = true; },
};
claimModalEscape(event, () => { childClosed += 1; });
if (!immediateStopped) claimModalEscape(event, () => { parentClosed += 1; });
if (childClosed !== 1 || parentClosed !== 0 || !immediateStopped) throw new Error("Nested Escape must close only the topmost modal");
immediateStopped = false;
claimModalEscape(event, () => { /* busy topmost modal intentionally stays open */ });
if (!immediateStopped) claimModalEscape(event, () => { parentClosed += 1; });
if (parentClosed !== 0 || !immediateStopped) throw new Error("Busy topmost modal must still own Escape without closing its parent");
if (claimModalEscape({ ...event, key: "Tab" }, () => { parentClosed += 1; })) throw new Error("Non-Escape keys must not close a modal");
console.log("CrewForge modal keyboard contract passed.");
