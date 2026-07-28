import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintToolCall, ToolLoopGuard } from "./toolLoopGuard.js";

test("warns and then blocks consecutive identical tool calls", () => {
  const guard = new ToolLoopGuard();
  assert.equal(guard.inspect("read_file", { path: "a.ts" }).action, "allow");
  assert.equal(guard.inspect("read_file", { path: "a.ts" }).action, "allow");
  assert.equal(guard.inspect("read_file", { path: "a.ts" }).action, "warn");
  const blocked = guard.inspect("read_file", { path: "a.ts" });
  assert.equal(blocked.action, "block");
  assert.equal(blocked.consecutiveCount, 4);
});

test("resets the streak when tool or arguments change", () => {
  const guard = new ToolLoopGuard();
  guard.inspect("read_file", { path: "a.ts" });
  guard.inspect("read_file", { path: "a.ts" });
  assert.equal(guard.inspect("read_file", { path: "b.ts" }).consecutiveCount, 1);
  assert.equal(guard.inspect("bash", { path: "b.ts" }).consecutiveCount, 1);
});

test("fingerprints equivalent object input independent of key order", () => {
  assert.equal(
    fingerprintToolCall("bash", { command: "pwd", nested: { b: 2, a: 1 } }),
    fingerprintToolCall("bash", { nested: { a: 1, b: 2 }, command: "pwd" })
  );
});
