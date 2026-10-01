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
import type { UserSession } from "../auth/sessionManager.js";

test("a continuation preserves the original goal and earlier corrections within context budget", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-history-budget-"));
  const priorFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = priorFetch; fs.rmSync(root, { recursive: true, force: true }); });
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "history-fixture", max_output_tokens: 1024 }] });
    requests.push(String(init?.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Acknowledged." } }] });
  };
  const taskManager = new TaskManager(root); const messageBus = new MessageBus(root);
  const session: UserSession = { token: "history-fixture", username: "tester", workspaceDir: root, workspaceRoot: root, isAdmin: false, isolated: false,
    taskManager, messageBus, teammateManager: new TeammateManager(root, messageBus, taskManager) };
  const history = [{ role: "user", content: "Original goal: evaluate IDE capability." }, { role: "user", content: "Correction: preserve the incomplete SPEC.md." },
    ...Array.from({ length: 12 }, (_, index) => ({ role: "assistant", content: `Evidence ${index}` }))];
  await runAgentLoop({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket, "Continue the evaluation", "history-turn", session, undefined, history,
    undefined, undefined, undefined, undefined, { mode: "ask", modelName: "history-fixture", isStopped: () => false, createAbortSignal: () => undefined });
  assert.equal(requests.length, 1);
  assert.match(requests[0], /Original goal: evaluate IDE capability/);
  assert.match(requests[0], /Correction: preserve the incomplete SPEC\.md/);
  assert.match(requests[0], /Evidence 11/);
});
