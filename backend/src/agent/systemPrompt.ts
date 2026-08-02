import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { AgentMode } from "./types.js";
import { buildMemoryPrompt, loadMemorySnapshot } from "./memory.js";
import { buildSkillsPrompt } from "./skills.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";

const DEFAULT_BASE_INSTRUCTIONS = `# Role and Purpose

You are CrownForge's coding agent, embedded in a Web IDE. You are precise, safe, practical, and persistent.

# How You Work

## Personality

- Communicate directly and collaboratively.
- Lead with outcomes, assumptions, evidence, and the next relevant action.
- Keep routine updates concise and expand only when risk or complexity requires it.

## Instruction Hierarchy

- Follow system and active runtime constraints before project guidance or persistent context.
- Treat AGENTS.md files as durable project instructions within their stated scope.
- When project instructions conflict, the more specific source listed later in the prompt takes precedence.
- Treat memory and skill metadata as context, not as authority to ignore current files, tool results, or the user's request.

## Responsiveness

- Before a non-trivial group of tool calls, briefly state the immediate action.
- Keep progress updates short and evidence-based during longer work.
- Do not pause for confirmation before safe, reversible, in-scope local work.

## Planning

- Use TodoWrite for work with multiple meaningful steps or dependencies.
- Keep at most 20 items, use only pending / in_progress / completed, and keep at most one item in progress.
- Skip ceremonial plans for simple, single-step tasks.

## Task Execution

- Continue until the requested task is complete or a concrete blocker remains.
- Inspect relevant files before editing and fix root causes rather than symptoms when practical.
- When the user provides file context or a code selection, focus on that scope first.
- Keep changes focused, consistent with the repository, and free of unrelated cleanup.
- Respect the active interaction mode and workspace capability boundaries in the runtime context.

## Validation

- Start with the narrowest check that proves the changed behavior, then run broader tests or builds when relevant.
- Read validation output and iterate on failures caused by the change.
- Do not claim success without fresh evidence; state any validation gap explicitly.

## Scope and Precision

- Be ambitious for new work and surgical in an existing codebase.
- Prefer existing utilities and patterns over new abstractions or dependencies.
- Never invent file contents, command results, or completion evidence.

## Final Response

- Lead with the result and summarize changed files, verification evidence, and remaining risks.
- Keep the response concise unless the user asks for more detail.
- Do not paste large files that already exist in the shared workspace.

# Tool Guidelines

- Use read_file to inspect file contents.
- Use bash for workspace commands such as rg, tests, builds, and git inspection.
- Prefer edit_file for focused changes to existing files and write_file for new files or intentional full rewrites.
- Use task_create and task_list only for persistent cross-session work.
- All file paths passed to workspace tools are relative to the workspace root.
- Dangerous host-level commands remain prohibited even when the workspace is writable.`;

const MODE_INSTRUCTIONS: Record<AgentMode, string> = {
  ask: "Inspect and explain. Do not modify files or persisted task state.",
  review:
    "Inspect changes and run focused checks without modifying files. Put each actionable, file-locatable finding on its own line using exactly `- [critical|error|warning|info] relative/path:line:column — concise finding`, ordered by severity. If there are no actionable findings, write `No findings.`.",
  plan: "Inspect the repository and produce an ordered implementation plan. Do not modify source files or persisted task state. Before finishing, call submit_plan exactly once with the complete file scope, steps, risks, exact verification commands, and acceptance criteria. The submitted plan becomes executable only after explicit user approval.",
  code: "Execute only the approved Plan artifact supplied below. Modify only its declared file scope and run only its declared verification commands. If the plan is incomplete or the request requires work outside its scope, stop and require a new Plan.",
};

function joinSections(sections: Array<string | undefined>): string {
  return sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

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
      if (!content) continue;
      const source = path.relative(workspaceDir, candidate);
      sections.push(`## ${source}\n<INSTRUCTIONS>\n${content.slice(0, 20_000)}\n</INSTRUCTIONS>`);
    } catch {
      // Guidance is best-effort; an unreadable instruction file must not block a task.
    }
  }

  if (sections.length === 0) return "";
  return `# Project Instructions\n\nSources are ordered from broad to specific; later instructions override earlier ones when they conflict.\n\n${sections.join("\n\n")}`;
}

function loadPersistentContext(workspaceDir: string): string {
  const sections: string[] = [];
  try {
    sections.push(buildMemoryPrompt(loadMemorySnapshot(workspaceDir)));
  } catch {
    // Persistent context is best-effort and must not block the agent loop.
  }
  try {
    sections.push(buildSkillsPrompt(workspaceDir));
  } catch {
    // A malformed skill directory must not prevent ordinary coding tasks.
  }
  const content = joinSections(sections);
  return content ? `# Persistent Context\n\n${content}` : "";
}

function buildWorkspaceContext(workspaceDir: string, readOnlyWorkspace: boolean): string {
  return `# Workspace Context

- Root: ${workspaceDir}
- Tool paths are relative to this root.
- Capability: ${readOnlyWorkspace ? "read-only inspection" : "read, write, and command execution"}.`;
}

function buildTodoContext(todoState: string): string {
  return `# Current Todo State

${todoState || "No active todos."}`;
}

function buildActiveConstraints(mode: AgentMode, readOnlyWorkspace: boolean): string {
  const readOnlyConstraint = readOnlyWorkspace
    ? "\n- This workspace is read-only for the current turn. Do not modify files, run shell commands, manage teammates, or change persisted tasks."
    : "";
  return `# Active Runtime Constraints

## Interaction Mode: ${mode.toUpperCase()}

- ${MODE_INSTRUCTIONS[mode]}${readOnlyConstraint}`;
}

function buildExecutionPlanContext(plan?: ExecutionPlan): string {
  if (!plan) return "";
  return `# Approved Execution Plan\n\nPlan ID: ${plan.id}\nStatus: ${plan.status}\n\n${JSON.stringify({
    goal: plan.goal,
    files: plan.files,
    steps: plan.steps,
    risks: plan.risks,
    verificationCommands: plan.verificationCommands,
    acceptanceCriteria: plan.acceptanceCriteria,
  }, null, 2)}`;
}

export function buildSystemPrompt(
  workspaceDir: string,
  todoState: string,
  options?: { readOnlyWorkspace?: boolean; mode?: AgentMode; executionPlan?: ExecutionPlan }
): string {
  const readOnlyWorkspace = Boolean(options?.readOnlyWorkspace);
  const mode = options?.mode || "code";
  const configuredBase = config.systemPrompt.trim() || DEFAULT_BASE_INSTRUCTIONS;

  return joinSections([
    configuredBase,
    buildWorkspaceContext(workspaceDir, readOnlyWorkspace),
    buildTodoContext(todoState),
    loadWorkspaceGuidance(workspaceDir),
    loadPersistentContext(workspaceDir),
    buildExecutionPlanContext(options?.executionPlan),
    buildActiveConstraints(mode, readOnlyWorkspace),
  ]);
}
