import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { UserSession } from "../auth/sessionManager.js";
import { listContextManifests } from "./contextManifestStore.js";
import { updateContextPreferences } from "./contextManifestStore.js";
import { getContextIndexAdapter, registerContextIndexAdapter } from "./contextManifestIndex.js";
import { runAgentLoop } from "./loop.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { TeammateManager } from "./teammateManager.js";

function sessionFor(workspaceDir: string, input: { isolated?: boolean; workspaceRoot?: string } = {}): UserSession {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  return {
    token: `context-${Math.random()}`,
    username: "context-user",
    workspaceDir,
    workspaceRoot: input.workspaceRoot || workspaceDir,
    isAdmin: false,
    isolated: Boolean(input.isolated),
    taskManager,
    messageBus,
    teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
  };
}

async function runOnce(
  workspaceDir: string,
  input: { requestId: string; conversationId: string; message: string; context?: { path: string; content: string; language: string }; session?: UserSession }
): Promise<string> {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = async (_url, init) => {
    body = String(init?.body || "");
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  };
  try {
    await runAgentLoop(
      { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket,
      input.message,
      input.requestId,
      input.session || sessionFor(workspaceDir),
      input.context,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        isStopped: () => false,
        createAbortSignal: () => undefined,
        mode: "ask",
        modelName: "test-model",
        conversationId: input.conversationId,
      }
    );
    return body;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("pin and exclude controls change the next provider payload and exact manifest candidates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-loop-context-"));
  fs.mkdirSync(path.join(root, "src"));
  const pinnedCanary = "PINNED_IMPLEMENTATION_CANARY_7391";
  const editorCanary = "ACTIVE_EDITOR_CANARY_7391";
  fs.writeFileSync(path.join(root, "src", "feature.ts"), `export const marker = "${pinnedCanary}";\n`, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const before = await runOnce(root, { requestId: "request-before-pin", conversationId: "conversation-controls", message: "Give a concise status" });
  assert.doesNotMatch(before, new RegExp(pinnedCanary));

  updateContextPreferences(root, "conversation-controls", {
    expectedVersion: 0,
    pins: [{ path: "src/feature.ts", reason: "Relevant implementation" }],
  });
  const pinned = await runOnce(root, { requestId: "request-after-pin", conversationId: "conversation-controls", message: "Give a concise status" });
  assert.match(pinned, new RegExp(pinnedCanary));
  assert.match(pinned, /repository_context/);
  const pinnedManifest = listContextManifests(root, { requestId: "request-after-pin" })[0];
  assert.ok(pinnedManifest.items.some((item) => item.source.path === "src/feature.ts" && item.decision === "included" && item.pinned));

  updateContextPreferences(root, "conversation-controls", {
    expectedVersion: 1,
    pins: [{ path: "src/feature.ts" }],
    excludes: ["src/feature.ts"],
  });
  const excluded = await runOnce(root, {
    requestId: "request-after-exclude",
    conversationId: "conversation-controls",
    message: "Review the current editor",
    context: { path: "src/feature.ts", content: editorCanary, language: "typescript" },
  });
  assert.doesNotMatch(excluded, new RegExp(pinnedCanary));
  assert.doesNotMatch(excluded, new RegExp(editorCanary));
  const excludedManifest = listContextManifests(root, { requestId: "request-after-exclude" })[0];
  assert.ok(excludedManifest.items.some((item) => item.source.path === "src/feature.ts" && item.decision === "excluded" && item.pinned));
  assert.ok(excludedManifest.items.some((item) => item.source.path === "src/feature.ts" && item.decision === "excluded" && item.kind === "editor_context"));
});

test("effective managed-worktree scope and viewer are passed to retrieval without parent leakage", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-loop-parent-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-loop-worktree-"));
  fs.mkdirSync(path.join(parent, "src"));
  fs.mkdirSync(path.join(worktree, "src"));
  fs.writeFileSync(path.join(parent, "src", "owned.ts"), "PARENT_SCOPE_CANARY_7391\n", "utf8");
  fs.writeFileSync(path.join(worktree, "src", "owned.ts"), "WORKTREE_SCOPE_CANARY_7391\n", "utf8");
  updateContextPreferences(worktree, "conversation-worktree", { expectedVersion: 0, pins: [{ path: "src/owned.ts" }] });
  t.after(() => { fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(worktree, { recursive: true, force: true }); });

  const actual = getContextIndexAdapter();
  let observed: { workspaceDir?: string; username?: string; kind?: string } = {};
  const restore = registerContextIndexAdapter({
    ...actual,
    retrieve: async (workspaceDir, input) => {
      observed = { workspaceDir, username: input.viewer.username, kind: input.scope.kind };
      return actual.retrieve(workspaceDir, input);
    },
  });
  t.after(restore);

  const body = await runOnce(worktree, {
    requestId: "request-worktree",
    conversationId: "conversation-worktree",
    message: "Inspect owned code",
    session: sessionFor(worktree, { isolated: true, workspaceRoot: parent }),
  });
  assert.match(body, /WORKTREE_SCOPE_CANARY_7391/);
  assert.doesNotMatch(body, /PARENT_SCOPE_CANARY_7391/);
  assert.deepEqual(observed, { workspaceDir: worktree, username: "context-user", kind: "managed_worktree" });
  assert.equal(listContextManifests(worktree, { requestId: "request-worktree" })[0]?.scope.kind, "managed_worktree");
});
