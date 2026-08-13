import assert from "node:assert/strict";
import test from "node:test";
import { resolveVisibleTreeIndex } from "../frontend/src/components/fileTreeKeyboardContract.js";

test("visible FileTree roving focus stays inside the rendered item range", () => {
  assert.equal(resolveVisibleTreeIndex(0, 3, "ArrowUp"), 0);
  assert.equal(resolveVisibleTreeIndex(0, 3, "ArrowDown"), 1);
  assert.equal(resolveVisibleTreeIndex(2, 3, "ArrowDown"), 2);
  assert.equal(resolveVisibleTreeIndex(2, 3, "ArrowUp"), 1);
});

test("visible FileTree roving focus supports Home and End and ignores unrelated keys", () => {
  assert.equal(resolveVisibleTreeIndex(1, 3, "Home"), 0);
  assert.equal(resolveVisibleTreeIndex(1, 3, "End"), 2);
  assert.equal(resolveVisibleTreeIndex(1, 3, "Enter"), null);
  assert.equal(resolveVisibleTreeIndex(0, 0, "ArrowDown"), null);
});
