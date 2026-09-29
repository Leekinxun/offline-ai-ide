import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { runAgentLoop } from "./loop.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { listFileMutations, rollbackFileMutations } from "../files/mutationRegistry.js";
import { readRunChanges } from "../chat/runChanges.js";
import type { UserSession } from "../auth/sessionManager.js";
import type { WsServerMessage } from "./types.js";
import { getAllTools } from "./tools.js";
import { evaluateModeCapability } from "./modeCapabilities.js";
import { classifyToolApproval } from "./toolApproval.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";

test("rename is a Code-only write capability whose approval and Plan scope cover both paths", () => {
  assert.ok(getAllTools({ mode: "code" }).some((tool) => tool.function.name === "rename_file"));
  assert.ok(getAllTools({ mode: "code", constrainedCode: true }).some((tool) => tool.function.name === "rename_file"));
  for (const mode of ["ask", "plan", "review"] as const) assert.equal(getAllTools({ mode }).some((tool) => tool.function.name === "rename_file"), false);
  assert.equal(getAllTools({ mode: "code", readOnly: true }).some((tool) => tool.function.name === "rename_file"), false);
  assert.equal(getAllTools({ mode: "code", readOnly: true, constrainedCode: true }).some((tool) => tool.function.name === "rename_file"), false);
  assert.equal(classifyToolApproval("rename_file", { source_path: "interview/题目.md", target_path: "interview/TASK.md" }).kind, "approval");
  for (const input of [{ source_path: "../outside.md", target_path: "TASK.md" }, { source_path: "source.md", target_path: "../TASK.md" }, { source_path: "source.md", target_path: ".git/config" }]) assert.equal(classifyToolApproval("rename_file", input).kind, "blocked");
  const plan = { id: "plan", files: ["interview/题目.md"], verificationCommands: [] } as unknown as ExecutionPlan;
  const input = { source_path: "interview/题目.md", target_path: "interview/TASK.md" };
  assert.equal(evaluateModeCapability({ mode: "code", toolName: "rename_file", input, executionPlan: plan }).allowed, false);
  assert.equal(evaluateModeCapability({ mode: "code", toolName: "rename_file", input, executionPlan: { ...plan, files: ["interview"] } }).allowed, true);
});

for (const deny of [false, true]) test(`real Agent loop ${deny ? "honors denied rename" : "renames ten nested Chinese files with auditable undo"}`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-rename-loop-"));
  const originalFetch = globalThis.fetch;
  const oldPolicy = process.env.CREWFORGE_ADMIN_POLICY;
  process.env.CREWFORGE_ADMIN_POLICY = path.join(root, "admin-policy.json");
  t.after(() => { globalThis.fetch = originalFetch; if (oldPolicy === undefined) delete process.env.CREWFORGE_ADMIN_POLICY; else process.env.CREWFORGE_ADMIN_POLICY = oldPolicy; fs.rmSync(root, { recursive: true, force: true }); });
  const count = deny ? 1 : 10;
  const sources = Array.from({ length: count }, (_, index) => `interview/q${index + 1} sample/题目.md`);
  for (const [index, source] of sources.entries()) { fs.mkdirSync(path.dirname(path.join(root, source)), { recursive: true }); fs.writeFileSync(path.join(root, source), `# Question ${index + 1}\nPreserve this content.\n`); }
  const contents = sources.map((source) => fs.readFileSync(path.join(root, source), "utf8"));
  const taskManager = new TaskManager(root); const messageBus = new MessageBus(root);
  const session: UserSession = { token: "rename-loop", username: "tester", workspaceDir: root, workspaceRoot: root, isAdmin: false, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(root, messageBus, taskManager) };
  const recorder = new AgentRunRecorder(root, "rename-run", "rename-conversation", "code");
  const events: WsServerMessage[] = []; const approvals: string[] = [];
  let step = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "rename-fixture" }] });
    const index = Math.floor(step / 2); const read = step++ % 2 === 0;
    const name = read ? "read_file" : "rename_file";
    const args = read ? { path: sources[index] } : { source_path: sources[index], target_path: sources[index]?.replace("题目.md", "TASK.md") };
    return Response.json({ choices: [{ finish_reason: index < count ? "tool_calls" : "stop", message: index < count
      ? { role: "assistant", content: null, tool_calls: [{ id: `${name}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: deny ? "The rename was declined." : "All Markdown filenames were changed; content was preserved." } }] });
  };
  await recorder.start();
  await runAgentLoop({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket, "Rename each interview subfolder's 题目.md to TASK.md.", "rename-request", session, undefined, undefined, (event) => events.push(event), undefined, undefined, undefined, {
    mode: "code", modelName: "rename-fixture", conversationId: "rename-conversation", runRecorder: recorder,
    isStopped: () => false, createAbortSignal: () => undefined,
    requestToolApproval: async (request) => { approvals.push(request.name); return deny ? "deny" : "allow_once"; },
  });
  assert.deepEqual(approvals, Array.from({ length: count }, () => "rename_file"));
  if (deny) {
    assert.equal(fs.readFileSync(path.join(root, sources[0]), "utf8"), contents[0]);
    assert.equal(fs.existsSync(path.join(root, sources[0].replace("题目.md", "TASK.md"))), false);
    assert.equal(listFileMutations(root, { runId: recorder.runId }).length, 0);
    assert.ok(events.some((event) => event.type === "tool_result" && event.name === "rename_file" && event.isError));
    return;
  }
  assert.equal(events.filter((event) => event.type === "tool_result" && event.name === "rename_file" && !event.isError && event.fileUpdate?.previousPath && event.fileUpdate?.previousVersion).length, 10);
  assert.equal(listFileMutations(root, { runId: recorder.runId }).length, 20, "the loop must not capture the same rename a second time");
  assert.equal(readRunChanges(root, recorder.runId).files.length, 20);
  for (const [index, source] of sources.entries()) {
    assert.equal(fs.existsSync(path.join(root, source)), false);
    assert.equal(fs.readFileSync(path.join(root, source.replace("题目.md", "TASK.md")), "utf8"), contents[index]);
  }
  const reverted = rollbackFileMutations(root, { runId: recorder.runId, requestId: "rename-request" });
  assert.equal(reverted.conflicts.length + reverted.unavailable.length, 0);
  for (const [index, source] of sources.entries()) {
    assert.equal(fs.readFileSync(path.join(root, source), "utf8"), contents[index]);
    assert.equal(fs.existsSync(path.join(root, source.replace("题目.md", "TASK.md"))), false);
  }
});
