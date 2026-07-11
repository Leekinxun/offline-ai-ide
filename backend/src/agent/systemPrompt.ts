import { config } from "../config.js";
import type { AgentMode } from "./types.js";
import fs from "fs";
import path from "path";

function loadWorkspaceGuidance(workspaceDir: string): string {
  const candidates = [
    path.join(workspaceDir, "AGENTS.md"),
    path.join(workspaceDir, ".codex", "AGENTS.md"),
  ];
  const sections: string[] = [];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, "utf-8").trim();
      if (content) sections.push(`### ${path.relative(workspaceDir, candidate)}\n${content.slice(0, 20_000)}`);
    } catch {
      // Guidance is best-effort; an unreadable instruction file must not block a task.
    }
  }

  return sections.length > 0
    ? `\n\n## Workspace Guidance\nFollow these project instructions:\n${sections.join("\n\n")}`
    : "";
}

export function buildSystemPrompt(
  workspaceDir: string,
  todoState: string,
  options?: { readOnlyWorkspace?: boolean; mode?: AgentMode }
): string {
  const customPrompt = config.systemPrompt;
  const readOnlyWorkspace = Boolean(options?.readOnlyWorkspace);
  const readOnlyNotice = readOnlyWorkspace
    ? `\n\n## Workspace Mode\n- The active team role is viewer, so this workspace is read-only for this turn.\n- Do not attempt to modify files, run shell commands, manage teammates, or change persisted tasks.\n- Focus on inspection, explanation, and planning.`
    : "";
  const mode = options?.mode || "code";
  const modeNotice = `\n\n## Interaction Mode: ${mode.toUpperCase()}\n- ASK: inspect and explain; do not modify files.\n- REVIEW: inspect changes and run focused checks; do not modify files.\n- PLAN: produce an ordered implementation plan and persist task items when useful; do not modify source files.\n- CODE: implement the requested change, run verification, and summarize evidence.`;
  const workspaceGuidance = loadWorkspaceGuidance(workspaceDir);

  if (customPrompt && customPrompt.trim()) {
    return `${customPrompt.trim()}${modeNotice}${workspaceGuidance}${readOnlyNotice}`;
  }

  return `You are an expert AI coding agent embedded in a Web IDE.
Your workspace is at: ${workspaceDir}

You have access to ${
    readOnlyWorkspace
      ? "read-only inspection tools for this turn."
      : "tools for reading, writing, and executing code."
  }
Use tools iteratively to accomplish tasks. When done, provide a concise text summary with changed files, verification evidence, and remaining risks.

## Tool Usage Guidelines
- Use read_file to inspect file contents before editing
- ${
    readOnlyWorkspace
      ? "This turn is read-only: do not propose or attempt write operations."
      : "Use bash to run shell commands (e.g., ls, cat, grep, npm, python, git)"
  }
- ${
    readOnlyWorkspace
      ? "Write/edit tools are intentionally unavailable in this mode."
      : "Use edit_file for surgical changes (prefer over write_file for existing files)"
  }
- ${
    readOnlyWorkspace
      ? "Shell and teammate-management tools are intentionally unavailable in this mode."
      : "Use write_file for creating new files or full rewrites"
  }
- Dangerous commands are blocked: rm -rf /, sudo, shutdown, reboot
- All file paths are relative to the workspace root

## Task Tracking
- Use TodoWrite to maintain a checklist for multi-step tasks
- Max 20 items, 3 statuses (pending, in_progress, completed), max 1 in_progress at a time
- ${
    readOnlyWorkspace
      ? "Persistent task-management tools may be unavailable in read-only mode."
      : "Use task_create/task_list for persistent cross-session task management"
  }

## Current Todo State
${todoState || "No active todos."}

When the user provides file context or code selection, focus on that specific code.
When generating or modifying code, always wrap it in a fenced code block with the appropriate language tag.
Be concise and precise.${modeNotice}${workspaceGuidance}${readOnlyNotice}`;
}
