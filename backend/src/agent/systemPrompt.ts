import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { AgentMode } from "./types.js";
import { buildMemoryPrompt, loadMemorySnapshot } from "./memory.js";
import { buildSkillsPrompt } from "./skills.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";
import { codeModeInstruction, resolveCodeExecutionContract } from "./executionContract.js";
import type { ContextSourceHint } from "./contextManifest.js";
import { redactSecrets } from "./secretRedaction.js";

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
  code: "",
};

function joinSections(sections: Array<string | undefined>): string {
  return sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

interface WorkspaceGuidanceSection { path: string; text: string; }

function isContained(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Read only the two explicitly authorized project-instruction files. This is a
 * narrow exception for `.codex/AGENTS.md`; it does not make `.codex` available
 * to indexing, search, pins, editor context, or any other retrieval surface.
 */
function readAuthorizedInstructionFile(
  workspaceDir: string,
  relativePath: string
): string | null {
  const root = fs.realpathSync.native(path.resolve(workspaceDir));
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); } catch { return null; }
    if (stat.isSymbolicLink()) return null;
  }
  const stat = fs.lstatSync(cursor);
  if (!stat.isFile()) return null;
  const canonical = fs.realpathSync.native(cursor);
  if (!isContained(canonical, root)) return null;
  let descriptor: number | undefined;
  let buffer: Buffer;
  try {
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(descriptor).isFile()) return null;
    buffer = fs.readFileSync(descriptor);
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  if (buffer.includes(0)) return null;
  return redactSecrets(buffer.toString("utf8")).trim().slice(0, 20_000) || null;
}

function normalizeInstructionScope(workspaceDir: string, scopePath: string | undefined): string[] {
  if (!scopePath || scopePath === ".") return [];
  const root = fs.realpathSync.native(path.resolve(workspaceDir));
  const lexical = path.resolve(root, scopePath);
  if (!isContained(lexical, root)) return [];
  const relative = path.relative(root, lexical);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length && path.extname(parts.at(-1) || "")) parts.pop();
  let cursor = root;
  const directories: string[] = [];
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); } catch { break; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) break;
    const canonical = fs.realpathSync.native(cursor);
    if (!isContained(canonical, root)) break;
    directories.push(path.relative(root, canonical).split(path.sep).join("/"));
  }
  return directories;
}

function loadWorkspaceGuidance(workspaceDir: string, scopePath?: string): WorkspaceGuidanceSection[] {
  const sections: WorkspaceGuidanceSection[] = [];
  const orderedPaths = [
    "AGENTS.md",
    ".codex/AGENTS.md",
    ...normalizeInstructionScope(workspaceDir, scopePath).map((directory) => `${directory}/AGENTS.md`),
  ];
  for (const relativePath of Array.from(new Set(orderedPaths))) {
    try {
      const content = readAuthorizedInstructionFile(workspaceDir, relativePath);
      if (content) sections.push({
        path: relativePath,
        text: `# Project Instructions\n\n## ${relativePath}\n<INSTRUCTIONS>\n${content}\n</INSTRUCTIONS>`,
      });
    } catch {
      // Guidance is best-effort; any boundary ambiguity fails closed by omission.
    }
  }
  return sections;
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

function buildActiveConstraints(
  mode: AgentMode,
  readOnlyWorkspace: boolean,
  executionPlan?: ExecutionPlan
): string {
  const readOnlyConstraint = readOnlyWorkspace
    ? "\n- This workspace is read-only for the current turn. Do not modify files, run shell commands, manage teammates, or change persisted tasks."
    : "";
  const modeInstruction = mode === "code"
    ? codeModeInstruction(resolveCodeExecutionContract(executionPlan))
    : MODE_INSTRUCTIONS[mode];
  return `# Active Runtime Constraints

## Interaction Mode: ${mode.toUpperCase()}

- ${modeInstruction}${readOnlyConstraint}`;
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
  options?: { readOnlyWorkspace?: boolean; mode?: AgentMode; executionPlan?: ExecutionPlan; scopePath?: string; targetPath?: string; activePath?: string }
): string {
  return buildSystemPromptBundle(workspaceDir, todoState, options).text;
}

export interface SystemPromptBundle {
  text: string;
  sources: ContextSourceHint[];
}

export function buildSystemPromptBundle(
  workspaceDir: string,
  todoState: string,
  options?: { readOnlyWorkspace?: boolean; mode?: AgentMode; executionPlan?: ExecutionPlan; scopePath?: string; targetPath?: string; activePath?: string }
): SystemPromptBundle {
  const readOnlyWorkspace = Boolean(options?.readOnlyWorkspace);
  const mode = options?.mode || "code";
  const configuredBase = config.systemPrompt.trim() || DEFAULT_BASE_INSTRUCTIONS;
  const parts: Array<{ text: string; source: ContextSourceHint }> = [];
  const add = (text: string, source: ContextSourceHint) => { if (text.trim()) parts.push({ text, source }); };
  add(configuredBase, { kind: "system_instruction", sourceType: "platform_runtime", reason: "Configured agent role and operating instructions", trust: "platform", integrity: "verified_digest" });
  add(buildWorkspaceContext(workspaceDir, readOnlyWorkspace), { kind: "workspace_scope", sourceType: "runtime_workspace", reason: "Effective workspace capability boundary", trust: "platform", integrity: "verified_digest" });
  add(buildTodoContext(todoState), { kind: "todo_state", sourceType: "runtime_todo", reason: "Current run task state", trust: "local_tool_output", integrity: "observed" });
  const instructionScope = options?.scopePath || options?.targetPath || options?.activePath;
  for (const guidance of loadWorkspaceGuidance(workspaceDir, instructionScope)) {
    add(guidance.text, {
      kind: "project_instruction",
      sourceType: "workspace_guidance",
      reason: "Explicitly authorized repository-scoped instruction file",
      path: guidance.path,
      trust: "workspace_instruction",
      integrity: "observed",
      ruleIds: ["authorized_instruction_file"],
    });
  }
  add(loadPersistentContext(workspaceDir), { kind: "persistent_context", sourceType: "workspace_memory_and_skills", reason: "Enabled persistent memory and skill catalog", trust: "workspace_instruction", integrity: "observed" });
  add(buildExecutionPlanContext(options?.executionPlan), { kind: "execution_plan", sourceType: "approved_execution_plan", reason: "User-approved execution constraints", planId: options?.executionPlan?.id, trust: "approved_user_artifact", integrity: "verified_digest" });
  add(buildActiveConstraints(mode, readOnlyWorkspace, options?.executionPlan), { kind: "runtime_constraint", sourceType: "mode_capability", reason: "Server-enforced active interaction constraints", trust: "platform", integrity: "verified_digest" });
  return {
    text: joinSections(parts.map((part) => part.text)),
    sources: parts.map((part) => ({ ...part.source, content: part.text, freshness: "fresh" })),
  };
}
