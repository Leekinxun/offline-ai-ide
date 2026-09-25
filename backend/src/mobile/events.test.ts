import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { UserSession } from "../auth/sessionManager.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { createActiveRun } from "../chat/runCoordinator.js";
import { mobileRevision, replayMobileInvalidations, subscribeMobileInvalidations } from "./events.js";

test("mobile stream coalesces bursty run output and replays a bounded cursor", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-mobile-events-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const session: UserSession = {
    token: crypto.randomUUID(), username: "owner", workspaceDir, workspaceRoot: workspaceDir,
    isAdmin: false, isolated: false,
    taskManager: {} as UserSession["taskManager"],
    messageBus: {} as UserSession["messageBus"],
    teammateManager: {} as UserSession["teammateManager"],
  };
  const run = createActiveRun({
    session,
    recorder: new AgentRunRecorder(workspaceDir, "run-mobile-events", "conversation-mobile-events", "ask"),
    queueSteering: async () => ({ ok: true, code: "accepted" }),
  });
  t.after(() => run.finish());
  const seen: number[] = [];
  const unsubscribe = subscribeMobileInvalidations(workspaceDir, (event) => seen.push(event.sequence));
  t.after(unsubscribe);
  for (let index = 0; index < 80; index++) {
    run.emit({ type: "text_delta", content: `chunk-${index}` } as any);
  }
  await new Promise((resolve) => setTimeout(resolve, 480));
  assert.deepEqual(seen, [1], "one phone snapshot refresh is enough for a burst of streamed text");
  assert.equal(mobileRevision(workspaceDir), 1);
  assert.deepEqual(replayMobileInvalidations(workspaceDir, 0)?.map((event) => event.sequence), [1]);
  assert.deepEqual(replayMobileInvalidations(workspaceDir, 1), []);
  assert.equal(replayMobileInvalidations(workspaceDir, 2), null);
});
