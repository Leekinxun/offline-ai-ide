import assert from "node:assert/strict";
import test from "node:test";
import { runWorkspaceCommand } from "./shell.js";

test("runs an allowed workspace command asynchronously", async () => {
  const output = await runWorkspaceCommand(
    `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`,
    process.cwd()
  );
  assert.equal(output, "ok");
});

test("aborts an in-flight shell command", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = runWorkspaceCommand(
    `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
    process.cwd(),
    controller.signal
  );
  setTimeout(() => controller.abort(), 50);
  assert.match(await pending, /stopped/i);
  assert.ok(Date.now() - startedAt < 2000);
});
