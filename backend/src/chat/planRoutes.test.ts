import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createApprovedExecutionPlan, requestExecutionPlanAmendment } from "./executionPlans.js";
import {
  appendConversationMessage,
  updateConversationState,
} from "./history.js";
import { chatRouter } from "../routes/chat.js";

async function withPlanApi(
  workspaceDir: string,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    (_req as any).userSession = { workspaceDir };
    next();
  });
  app.use(chatRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function planInput() {
  return {
    goal: "Expose the plan",
    files: ["src/plan.ts"],
    steps: ["Add the route"],
    risks: [],
    verification_commands: ["npm test"],
    acceptance_criteria: ["The route returns a plan"],
  };
}

test("reads normalized workspace plans and resolves amendments", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-routes-"));
  try {
    const plan = createApprovedExecutionPlan(workspaceDir, planInput(), {
      conversationId: "conversation-1",
      planRunId: "run-plan",
    });
    const pending = requestExecutionPlanAmendment(workspaceDir, plan.id, {
      reason: "Need a test file",
      requestedFiles: ["src/plan.test.ts"],
    }, "run-code");
    const amendment = pending.amendmentRequests![0];

    await withPlanApi(workspaceDir, async (baseUrl) => {
      const readResponse = await fetch(`${baseUrl}/plans/${plan.id}`);
      assert.equal(readResponse.status, 200);
      const readPayload = await readResponse.json() as { plan: typeof plan };
      assert.equal(readPayload.plan.id, plan.id);
      assert.deepEqual(readPayload.plan.amendmentRequests, pending.amendmentRequests);

      const resolveResponse = await fetch(
        `${baseUrl}/plans/${plan.id}/amendments/${amendment.id}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approved" }) }
      );
      assert.equal(resolveResponse.status, 200);
      const resolvePayload = await resolveResponse.json() as { plan: typeof plan };
      assert.equal(resolvePayload.plan.amendmentRequests?.[0]?.status, "approved");
      assert.deepEqual(resolvePayload.plan.files, ["src/plan.ts", "src/plan.test.ts"]);
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("maps invalid and missing plan routes without exposing workspace paths", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-routes-"));
  try {
    await withPlanApi(workspaceDir, async (baseUrl) => {
      const invalid = await fetch(`${baseUrl}/plans/..%2Fsecret`);
      assert.equal(invalid.status, 400);

      const missing = await fetch(`${baseUrl}/plans/plan-missing`);
      assert.equal(missing.status, 404);
      const payload = await missing.json() as { error: string };
      assert.equal(payload.error, "Execution plan not found");
      assert.ok(!payload.error.includes(workspaceDir));

      const invalidDecision = await fetch(`${baseUrl}/plans/plan-missing/amendments/amendment-1`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "defer" }),
      });
      assert.equal(invalidDecision.status, 400);
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("includes a conversation's last run id when reading it", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-plan-routes-"));
  try {
    const conversationId = "conversation-reload";
    await appendConversationMessage(workspaceDir, conversationId, {
      role: "user",
      content: "Continue this task",
      timestamp: Date.now(),
    });
    await updateConversationState(workspaceDir, conversationId, { lastRunId: "run-restore" });

    await withPlanApi(workspaceDir, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/conversations/${conversationId}`);
      assert.equal(response.status, 200);
      const payload = await response.json() as { lastRunId?: string; messages: unknown[] };
      assert.equal(payload.lastRunId, "run-restore");
      assert.equal(payload.messages.length, 1);
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
