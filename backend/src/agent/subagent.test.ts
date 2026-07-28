import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listChildRuns } from "../chat/runHistory.js";
import { clearModelCapabilityCache } from "./modelCapabilities.js";
import { runSubagent } from "./subagent.js";

test("records a queryable child run for a delegated subagent", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-subagent-"));
  const originalFetch = globalThis.fetch;
  clearModelCapabilityCache();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return Response.json({ data: [{ id: "test-model", max_output_tokens: 1024 }] });
    }
    if (url.endsWith("/chat/completions")) {
      return Response.json({
        choices: [{
          message: { role: "assistant", content: "delegated result" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }
    return new Response("not found", { status: 404 });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    clearModelCapabilityCache();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const output = await runSubagent(
    "inspect",
    "Explore",
    workspaceDir,
    "http://provider.test/v1",
    "test-model",
    undefined,
    undefined,
    undefined,
    {
      parentRunId: "parent-run",
      parentConversationId: "conversation-1",
      parentRequestId: "request-1",
      parentToolCallId: "tool-call-1",
    }
  );

  assert.equal(output, "delegated result");
  const children = listChildRuns(workspaceDir, "parent-run");
  assert.equal(children.length, 1);
  assert.equal(children[0].status, "completed");
  assert.equal(children[0].agentName, "subagent:Explore");
  assert.equal(children[0].metrics.totalTokens, 7);
});
