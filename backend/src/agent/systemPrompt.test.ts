import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";
import { buildSystemPrompt, buildSystemPromptBundle } from "./systemPrompt.js";
import { processModelTurn } from "./modelProcessor.js";

const approvedPlan: ExecutionPlan = {
  id: "plan-1", conversationId: "conversation-1", planRunId: "run-1", status: "approved",
  goal: "Test contracts", files: ["src/agent"], steps: ["Edit"], risks: [],
  verificationCommands: ["npm test"], acceptanceCriteria: ["Works"], createdAt: 1,
  approvedAt: 1, updatedAt: 1, executionRunIds: [],
};

function withSystemPrompt(value: string, run: () => void): void {
  const previous = config.systemPrompt;
  config.systemPrompt = value;
  try {
    run();
  } finally {
    config.systemPrompt = previous;
  }
}

test("buildSystemPrompt separates stable instructions from ordered runtime context", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-prompt-"));
  fs.mkdirSync(path.join(workspaceDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "Root guidance", "utf-8");
  fs.writeFileSync(path.join(workspaceDir, ".codex", "AGENTS.md"), "Specific guidance", "utf-8");
  fs.writeFileSync(path.join(workspaceDir, ".codex", "USER.md"), "Prefer concise updates", "utf-8");
  const skillDir = path.join(workspaceDir, ".codex", "skills", "focused-review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: focused-review\ndescription: Review focused changes\n---\n\n# Focused Review\n",
    "utf-8"
  );

  try {
    withSystemPrompt("", () => {
      const prompt = buildSystemPrompt(workspaceDir, "1. [in_progress] Refactor prompt", {
        mode: "code",
      });

      const expectedHeadings = [
        "# Role and Purpose",
        "# How You Work",
        "# Tool Guidelines",
        "# Workspace Context",
        "# Current Todo State",
        "# Project Instructions",
        "# Persistent Context",
        "# Active Runtime Constraints",
      ];
      let previousIndex = -1;
      for (const heading of expectedHeadings) {
        const index = prompt.indexOf(heading);
        assert.ok(index > previousIndex, `${heading} should appear in order`);
        previousIndex = index;
      }

      assert.match(prompt, /## AGENTS\.md\n<INSTRUCTIONS>\nRoot guidance/);
      assert.match(prompt, /## \.codex\/AGENTS\.md\n<INSTRUCTIONS>\nSpecific guidance/);
      assert.ok(prompt.indexOf("Root guidance") < prompt.indexOf("Specific guidance"));
      assert.match(prompt, /## Persistent Memory/);
      assert.match(prompt, /Prefer concise updates/);
      assert.match(prompt, /## Workspace Skills/);
      assert.match(prompt, /focused-review/);
      assert.match(prompt, /## Interaction Mode: CODE/);
      assert.match(prompt, /1\. \[in_progress\] Refactor prompt/);
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("custom base keeps runtime mode and read-only constraints", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-prompt-"));
  try {
    withSystemPrompt("Custom product behavior", () => {
      const prompt = buildSystemPrompt(workspaceDir, "", {
        mode: "review",
        readOnlyWorkspace: true,
      });

      assert.ok(prompt.startsWith("Custom product behavior"));
      assert.doesNotMatch(prompt, /# Role and Purpose/);
      assert.match(prompt, /# Workspace Context/);
      assert.match(prompt, /Capability: read-only inspection/);
      assert.match(prompt, /## Interaction Mode: REVIEW/);
      assert.match(prompt, /This workspace is read-only for the current turn/);
      assert.ok(prompt.lastIndexOf("# Active Runtime Constraints") > prompt.indexOf("Custom product behavior"));
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("system prompt bundle preserves section-level provenance without changing text", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-prompt-bundle-"));
  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "Workspace instruction", "utf8");
  try {
    const bundle = buildSystemPromptBundle(workspaceDir, "No active todos.", { mode: "code" });
    assert.equal(bundle.text, buildSystemPrompt(workspaceDir, "No active todos.", { mode: "code" }));
    assert.ok(bundle.sources.some((source) => source.sourceType === "workspace_guidance" && source.trust === "workspace_instruction"));
    assert.ok(bundle.sources.every((source) => typeof source.content === "string" && source.content.length > 0));
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("workspace instruction loading rejects symlinks and redacts secrets before provider egress", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-prompt-boundary-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-prompt-outside-"));
  const outsideCanary = "EXTERNAL_GUIDANCE_CANARY_7391";
  const secretCanary = "sk-test_INSTRUCTION_CANARY_123456";
  fs.writeFileSync(path.join(outsideDir, "AGENTS.md"), outsideCanary, "utf8");
  fs.symlinkSync(path.join(outsideDir, "AGENTS.md"), path.join(workspaceDir, "AGENTS.md"));
  fs.mkdirSync(path.join(workspaceDir, ".codex"));
  fs.writeFileSync(path.join(workspaceDir, ".codex", "AGENTS.md"), `Keep this rule. token=${secretCanary}`, "utf8");

  const originalFetch = globalThis.fetch;
  let providerBody = "";
  globalThis.fetch = async (_input, init) => {
    providerBody = String(init?.body || "");
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const bundle = buildSystemPromptBundle(workspaceDir, "", { mode: "code" });
  assert.doesNotMatch(bundle.text, new RegExp(outsideCanary));
  assert.doesNotMatch(bundle.text, new RegExp(secretCanary));
  assert.match(bundle.text, /Keep this rule/);
  assert.equal(bundle.sources.some((source) => source.path === "AGENTS.md"), false);
  assert.equal(bundle.sources.some((source) => source.path === ".codex/AGENTS.md"), true);

  await processModelTurn({
    apiUrl: "http://provider.test/v1",
    model: "model",
    systemPrompt: bundle.text,
    messages: [{ role: "user", content: "hello" }],
    fallbackMaxOutputTokens: 100,
    maxOutputTokens: 100,
    contextAudit: {
      storeWorkspaceDir: workspaceDir,
      scope: { kind: "workspace", scopeId: "workspace" },
      purpose: "agent_turn",
      agentId: "code",
      systemPromptSources: bundle.sources,
    },
  });
  assert.doesNotMatch(providerBody, new RegExp(outsideCanary));
  assert.doesNotMatch(providerBody, new RegExp(secretCanary));

  fs.rmSync(path.join(workspaceDir, ".codex"), { recursive: true, force: true });
  fs.symlinkSync(outsideDir, path.join(workspaceDir, ".codex"));
  const symlinkedDirectoryPrompt = buildSystemPrompt(workspaceDir, "", { mode: "code" });
  assert.doesNotMatch(symlinkedDirectoryPrompt, new RegExp(outsideCanary));
});

test("Code-mode instructions are generated from the active execution contract", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-prompt-"));
  try {
    const direct = buildSystemPrompt(workspaceDir, "", { mode: "code" });
    const planned = buildSystemPrompt(workspaceDir, "", { mode: "code", executionPlan: approvedPlan });
    assert.match(direct, /without a Plan artifact/);
    assert.match(planned, /amendment-required decision/);
    assert.doesNotMatch(direct, /request_plan_amendment/);
    assert.match(planned, /call request_plan_amendment/);
    assert.doesNotMatch(planned, /without a Plan artifact/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
