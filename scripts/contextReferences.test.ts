import assert from "node:assert/strict";
import test from "node:test";
import { addContextReference, findReferenceMention, referenceCandidates } from "../frontend/src/utils/contextReferences.js";

test("mention detection is caret scoped and does not mistake email addresses for references", () => {
  assert.equal(findReferenceMention("mail a@example.com", 18), null);
  assert.deepEqual(findReferenceMention("Review @src/test", 16), { start: 7, end: 16, query: "src/test" });
  assert.deepEqual(findReferenceMention("@file:src after", 9), { start: 0, end: 9, query: "file:src" });
  assert.equal(findReferenceMention("hello @", 5), null);
});

test("workspace candidates filter paths, directories, source prefixes and protected entries", () => {
  const tree = [{ name: "src", path: "src", type: "directory" as const, children: [
    { name: "main.ts", path: "src/main.ts", type: "file" as const },
    { name: ".env", path: "src/.env", type: "file" as const },
  ] }, { name: "node_modules", path: "node_modules", type: "directory" as const, children: [{ name: "a.js", path: "node_modules/a.js", type: "file" as const }] }];
  assert.deepEqual(referenceCandidates(tree, "file:main"), [{ kind: "file", path: "src/main.ts" }]);
  assert.deepEqual(referenceCandidates(tree, "folder:"), [{ kind: "folder", path: "src" }]);
  assert.equal(referenceCandidates(tree, "").length, 2);
});

test("references deduplicate without mixing source kinds and enforce the composer limit", () => {
  const current = [{ kind: "file" as const, path: "src/a.ts" }];
  assert.equal(addContextReference(current, current[0]), current);
  assert.equal(addContextReference(current, { kind: "selection", path: "src/a.ts" }).length, 2);
  const full = Array.from({ length: 16 }, (_, i) => ({ kind: "file" as const, path: `${i}.ts` }));
  assert.equal(addContextReference(full, { kind: "terminal" }), full);
});

test("reselecting a symbol refreshes its version and keeps distinct declarations in the same file", () => {
  const range = { startLine: 1, startColumn: 10, endLine: 1, endColumn: 14 };
  const reference = { kind: "symbol" as const, path: "src/a.ts", symbol: "work", range, version: "old" };
  assert.deepEqual(addContextReference([reference], { ...reference, version: "new" }), [{ ...reference, version: "new" }]);
  assert.equal(addContextReference([reference], { ...reference, symbol: "other" }).length, 2);
});
