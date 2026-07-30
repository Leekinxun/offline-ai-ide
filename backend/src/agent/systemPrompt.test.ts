import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import { buildSystemPrompt } from "./systemPrompt.js";

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
