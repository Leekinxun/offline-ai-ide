import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listFileMutations } from "../files/mutationRegistry.js";
import { TOOL_DISPATCH } from "./tools.js";

test("primary write_file and edit_file preserve exact preimages with run and tool attribution", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-primary-mutations-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "existing.txt"), "before");
  const context = {
    workspaceDir,
    actorName: "primary-user",
    runId: "run-primary",
    requestId: "request-primary",
    toolCallId: "write-call",
  };

  await TOOL_DISPATCH.write_file({ path: "existing.txt", content: "after" }, context as never);
  await TOOL_DISPATCH.write_file({ path: "created.txt", content: "created" }, {
    ...context,
    toolCallId: "create-call",
  } as never);
  await TOOL_DISPATCH.edit_file({ path: "existing.txt", old_text: "after", new_text: "edited" }, {
    ...context,
    toolCallId: "edit-call",
  } as never);

  const modified = listFileMutations(workspaceDir, { runId: "run-primary", toolCallId: "write-call" });
  assert.equal(modified.length, 1);
  assert.deepEqual(modified[0] && {
    path: modified[0].path,
    operation: modified[0].operation,
    preimageContent: modified[0].preimageContent,
    actor: modified[0].actor,
  }, { path: "existing.txt", operation: "modify", preimageContent: "before", actor: "primary-user" });
  const created = listFileMutations(workspaceDir, { toolCallId: "create-call" });
  assert.equal(created[0]?.operation, "create");
  assert.equal(created[0]?.preimageContent, undefined);
  const edited = listFileMutations(workspaceDir, { toolCallId: "edit-call" });
  assert.deepEqual(edited[0] && {
    operation: edited[0].operation,
    preimageContent: edited[0].preimageContent,
  }, { operation: "modify", preimageContent: "after" });

  await TOOL_DISPATCH.write_file({ path: "created.txt", content: "created" }, {
    ...context,
    toolCallId: "no-op-call",
  } as never);
  assert.equal(listFileMutations(workspaceDir, { toolCallId: "no-op-call" }).length, 0);
});
