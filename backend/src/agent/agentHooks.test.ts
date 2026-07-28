import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAgentHooksForTests,
  registerAgentHooks,
  runAgentHooks,
} from "./agentHooks.js";

test("runs lifecycle hooks in registration order and isolates noncritical failures", async (t) => {
  clearAgentHooksForTests();
  t.after(clearAgentHooksForTests);
  const calls: string[] = [];
  registerAgentHooks({
    name: "one",
    handlers: { beforeToolExecute: () => { calls.push("one"); } },
  });
  registerAgentHooks({
    name: "broken",
    handlers: { beforeToolExecute: () => { throw new Error("noisy"); } },
  });
  registerAgentHooks({
    name: "two",
    handlers: { beforeToolExecute: () => { calls.push("two"); } },
  });
  const failures = await runAgentHooks("beforeToolExecute", { agentId: "code" });
  assert.deepEqual(calls, ["one", "two"]);
  assert.deepEqual(failures, [{ name: "broken", error: "noisy" }]);
});

test("critical hooks fail closed", async (t) => {
  clearAgentHooksForTests();
  t.after(clearAgentHooksForTests);
  registerAgentHooks({
    name: "policy",
    critical: true,
    handlers: { beforePermissionCheck: () => { throw new Error("denied by policy"); } },
  });
  await assert.rejects(
    runAgentHooks("beforePermissionCheck", { agentId: "code" }),
    /Critical agent hook 'policy'/
  );
});
