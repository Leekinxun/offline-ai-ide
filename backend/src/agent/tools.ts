import path from "path";
import crypto from "node:crypto";
import { safePath } from "../utils/safePath.js";
import {
  FileSelectionRange,
  OpenAIToolDef,
  ToolContext,
  ToolFileUpdate,
} from "./types.js";
import { TodoManager } from "./todoManager.js";
import { TaskManager } from "./taskManager.js";
import { MessageBus } from "./messageBus.js";
import { TeammateManager } from "./teammateManager.js";
import { beginCompletionAttempt, runRepositoryCompletionGate } from "../extensions/policy/completionGate.js";
import { runSubagent } from "./subagent.js";
import { buildFileVersion, prepareFileMutationBatch } from "../files/mutationRegistry.js";
import { readMemory, writeMemory } from "./memory.js";
import { loadWorkspaceSkill } from "./skills.js";
import { evaluateWorkspaceWrite } from "./toolPolicy.js";
import { runInspectionCommand, runWorkspaceCommand, runReadOnlyShellCommand } from "./shell.js";
import { planReadOnlyShell } from "./readOnlyShell.js";
import { networkGrantForTool } from "./networkAccess.js";
import { createApprovedExecutionPlan } from "../chat/executionPlans.js";
import { requestAgentQuestion } from "../chat/agentQuestions.js";
import { readAuthorizedAgentBytes } from "./externalFileAccess.js";
import { assertAuthorizedContextContent, isBinaryContextBuffer, isExpectedTextPath, NUL_TEXT_RECOVERY } from "./contextPolicy.js";
import { renameWorkspaceFile } from "./renameFile.js";
import { TraceStore, type CollaborationEventReferences } from "../chat/traceStore.js";
import { REPOSITORY_INSPECTION_TOOLS, executeRepositoryInspectionTool } from "./repositoryInspection.js";
import { SUBAGENT_ROLES } from "./subagentRoles.js";
import { executeProcessTool, pendingAgentProcesses, type AgentProcessResult } from "./processTools.js";
import { readRunEvidence } from "./runEvidence.js";
import {
  assertFileVersion, atomicWriteFile, normalizeEditablePath, readEditableFile,
  rememberFileRead, rememberFileWrite, replaceUniqueText,
} from "./fileEditSafety.js";

// ---- Tool handler type ----

export interface ToolExecutionResult {
  output: string;
  fileUpdate?: ToolFileUpdate;
  process?: AgentProcessResult;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext & {
    todoManager: TodoManager;
    taskManager: TaskManager;
    messageBus: MessageBus;
    teammateManager: TeammateManager;
  }
) => Promise<string | ToolExecutionResult>;

// Tool calls may be retried by providers. Keep command responses stable within the
// process so a retry cannot create a second task/message while a lease is active.
const COMMAND_RESULTS = new Map<string, string>();
function collaborationActor(ctx: ToolContext): string {
  return ctx.subagentDepth ? ctx.actorName || "subagent" : "lead";
}
function idempotentCommand(ctx: ToolContext, key: unknown, run: () => string): string {
  const id = typeof key === "string" ? key.trim() : "";
  if (!id) return run();
  const cacheKey = `${ctx.workspaceDir}:${id}`;
  const existing = COMMAND_RESULTS.get(cacheKey);
  if (existing !== undefined) return existing;
  const result = run(); COMMAND_RESULTS.set(cacheKey, result);
  if (COMMAND_RESULTS.size > 10_000) COMMAND_RESULTS.delete(COMMAND_RESULTS.keys().next().value!);
  return result;
}

function collaborationReferences(ctx: ToolContext, extra: Partial<CollaborationEventReferences> = {}): CollaborationEventReferences {
  return {
    runId: ctx.runId,
    agentId: ctx.agentProfileId || "primary",
    parentRunId: ctx.lineage?.parentRunId,
    parentTaskId: ctx.lineage?.parentTaskId,
    requestId: ctx.requestId || ctx.lineage?.parentRequestId,
    toolCallId: ctx.toolCallId || ctx.lineage?.parentToolCallId,
    ...extra,
  };
}

// ---- Core tool implementations ----

function offsetToPosition(text: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, safeOffset).split("\n");
  return {
    line: before.length,
    column: before[before.length - 1].length + 1,
  };
}

function createSelectionRange(
  text: string,
  startOffset: number,
  endOffset: number
): FileSelectionRange {
  const start = offsetToPosition(text, startOffset);
  const end = offsetToPosition(text, endOffset);
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function normalizeNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const REVIEW_SEVERITIES = new Set(["critical", "error", "warning", "info"]);
const REVIEW_LENSES = new Set(["correctness", "security", "performance", "test", "api_contract", "maintainability"]);

/**
 * Validate the review tool payload at the execution boundary. The model schema
 * is advisory, so this is also the guard used before a finding is persisted.
 */
function sanitizeReviewFinding(args: Record<string, unknown>, workspaceDir: string):
  | { finding: Record<string, unknown> }
  | { error: string } {
  const severity = typeof args.severity === "string" ? args.severity : "";
  const lens = typeof args.lens === "string" ? args.lens : "";
  const rawPath = typeof args.path === "string"
    ? args.path.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/{2,}/g, "/")
    : "";
  const line = typeof args.line === "number" ? args.line : Number.NaN;
  const column = typeof args.column === "number" ? args.column : undefined;
  const message = typeof args.message === "string" ? args.message.trim() : "";
  const reviewedRevision = typeof args.reviewedRevision === "string" ? args.reviewedRevision.trim() : "";
  const reproduction = typeof args.reproduction === "string" ? args.reproduction.trim() : "";
  const evidence = normalizeNonEmptyStringArray(args.evidence)
    .map((value) => value.slice(0, 2_000))
    .slice(0, 20);

  if (!REVIEW_SEVERITIES.has(severity)) return { error: "severity must be critical, error, warning, or info" };
  if (!REVIEW_LENSES.has(lens)) return { error: "lens is not a supported review lens" };
  if (!rawPath || rawPath.length > 1_000 || path.posix.isAbsolute(rawPath) || /^[A-Za-z]:\//.test(rawPath) || rawPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return { error: "path must be a safe workspace-relative path" };
  }
  try {
    // Detect both traversal and symlink escapes, even though this tool is read-only.
    safePath(rawPath, workspaceDir);
  } catch {
    return { error: "path must resolve inside the workspace" };
  }
  if (!Number.isSafeInteger(line) || line < 1 || line > 10_000_000) return { error: "line must be a positive integer" };
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > 1_000_000)) return { error: "column must be a positive integer" };
  if (!message || message.length > 4_000) return { error: "message must be 1 to 4000 characters" };
  if (!reviewedRevision || reviewedRevision.length > 160) return { error: "reviewedRevision must be 1 to 160 characters" };
  if (reproduction.length > 2_000) return { error: "reproduction must be at most 2000 characters" };
  if ((severity === "critical" || severity === "error") && evidence.length === 0 && !reproduction) {
    return { error: "critical and error findings require direct evidence or a reproduction" };
  }

  return {
    finding: {
      severity,
      lens,
      path: rawPath,
      line,
      ...(column === undefined ? {} : { column }),
      message,
      evidence,
      reviewedRevision,
      ...(reproduction ? { reproduction } : {}),
    },
  };
}

export async function runReadFile(
  filePath: string,
  limit: number | undefined,
  cwd: string,
  options: { offset?: unknown; start_line?: unknown; character_offset?: unknown } = {},
  context?: Pick<ToolContext, "actorName" | "runId" | "requestId" | "agentProfileId" | "externalReadRoots" | "getExternalReadRoots">
): Promise<string> {
  try {
    const integer = (value: unknown, name: string, minimum: number): number => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${name} must be an integer >= ${minimum}`);
      }
      return value;
    };
    if ([options.offset, options.start_line, options.character_offset].filter((value) => value !== undefined).length > 1) {
      throw new Error("Use only one of offset, start_line, or character_offset");
    }
    const lineLimit = limit === undefined ? undefined : integer(limit, "limit", 1);
    let firstLine = options.start_line !== undefined
      ? integer(options.start_line, "start_line", 1) - 1
      : options.offset !== undefined ? integer(options.offset, "offset", 0) : 0;
    if (options.character_offset !== undefined) integer(options.character_offset, "character_offset", 0);
    const file = readAuthorizedAgentBytes(cwd, filePath, context?.getExternalReadRoots?.() ?? context?.externalReadRoots ?? []);
    if (!file.external && isBinaryContextBuffer(file.buffer)) {
      if (isExpectedTextPath(file.path) && file.buffer.includes(0) && Buffer.from(file.buffer.toString("utf8"), "utf8").equals(file.buffer)) {
        throw new Error(`Context file is not authorized: binary. ${NUL_TEXT_RECOVERY}`);
      }
      return JSON.stringify({
        path: file.path, read_only: true, content_kind: "binary", size_bytes: file.size,
        sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
        ...(file.buffer.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ? { format: "sqlite" } : {}),
        inspection_only: true, notice: "Binary content is excluded from text context. Metadata is not verification evidence; verify through a normally approved command tool.",
      });
    }
    const content = assertAuthorizedContextContent(file.buffer);
    const lineStarts = [0];
    for (let index = 0; index < content.length; index += 1) if (content[index] === "\n") lineStarts.push(index + 1);
    if (firstLine >= lineStarts.length) throw new Error("Requested line is past the end of the file");
    const start = options.character_offset !== undefined
      ? integer(options.character_offset, "character_offset", 0)
      : lineStarts[firstLine];
    if (start > content.length) throw new Error("character_offset is past the end of the file");
    if (options.character_offset !== undefined) {
      while (firstLine + 1 < lineStarts.length && lineStarts[firstLine + 1] <= start) firstLine += 1;
    }
    const requestedEnd = lineLimit === undefined ? content.length : lineStarts[firstLine + lineLimit] ?? content.length;
    let end = Math.min(requestedEnd, start + 50_000);
    if (end < requestedEnd) {
      // Prefer whole lines, but permit explicit character continuation for a
      // line longer than the page budget. Never silently lose the remainder.
      const boundary = content.lastIndexOf("\n", end - 1) + 1;
      if (boundary > start) end = boundary;
      else if (/[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end -= 1;
    }
    const nextLine = end < content.length ? lineStarts.indexOf(end) : -1;
    const truncated = end < content.length;
    if (!file.external) rememberFileRead(cwd, file.path, content, start, end, context);
    return JSON.stringify({
      path: file.path,
      ...(file.external ? { read_only: true, source: "external" } : {}),
      version: buildFileVersion(content),
      start_line: firstLine + 1,
      offset: firstLine,
      character_offset: start,
      total_lines: lineStarts.length,
      total_characters: content.length,
      complete: start === 0 && !truncated,
      truncated,
      next_offset: nextLine >= 0 ? nextLine : null,
      next_start_line: nextLine >= 0 ? nextLine + 1 : null,
      next_character_offset: truncated ? end : null,
      content: content.slice(start, end),
    });
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runWriteFile(
  filePath: string,
  content: string,
  cwd: string,
  context: Pick<ToolContext, "actorName" | "runId" | "requestId" | "agentProfileId" | "toolCallId">,
  expectedVersion?: unknown
): Promise<string | ToolExecutionResult> {
  try {
    filePath = normalizeEditablePath(filePath);
    if ((context.runId || context.requestId) && pendingAgentProcesses({ ...context, workspaceDir: cwd }, true).some((process) => process.session.status === "running")) return "Error: Poll or stop the active Agent process before modifying workspace files";
    if (typeof content !== "string") return "Error: content must be a string";
    if (content.includes("\0")) throw new Error("Text file writes cannot contain NUL bytes. Use escaped text (repr or hex) for binary headers, or an approved command tool to generate binary artifacts.");
    const policy = evaluateWorkspaceWrite(filePath);
    if (!policy.allowed) return `Error: Write blocked by workspace policy: ${policy.reason}`;
    const preimageContent = readEditableFile(cwd, filePath);
    assertFileVersion(cwd, filePath, preimageContent, expectedVersion, true, context);
    if (preimageContent === content) {
      return `No changes to ${filePath}`;
    }
    const batch = prepareFileMutationBatch([{
      workspaceDir: cwd,
      path: filePath,
      source: "assistant_tool",
      actor: context.actorName,
      runId: context.runId,
      requestId: context.requestId,
      toolCallId: context.toolCallId,
      preimageContent,
      postimageContent: content,
    }], { hunks: true });
    try {
      atomicWriteFile(cwd, filePath, content, preimageContent, { commit: (stat) => batch.commit({ mtimeMs: stat.mtimeMs }) });
    } finally {
      batch.cancel();
    }
    rememberFileWrite(cwd, filePath, content, context, true);
    return {
      output: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}\nversion: ${buildFileVersion(content)}`,
      fileUpdate: {
        path: filePath,
        content,
      },
    };
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runEditFile(
  filePath: string,
  oldText: string,
  newText: string,
  cwd: string,
  context: Pick<ToolContext, "actorName" | "runId" | "requestId" | "agentProfileId" | "toolCallId">,
  expectedVersion?: unknown
): Promise<string | ToolExecutionResult> {
  try {
    filePath = normalizeEditablePath(filePath);
    if ((context.runId || context.requestId) && pendingAgentProcesses({ ...context, workspaceDir: cwd }, true).some((process) => process.session.status === "running")) return "Error: Poll or stop the active Agent process before modifying workspace files";
    const policy = evaluateWorkspaceWrite(filePath);
    if (!policy.allowed) return `Error: Edit blocked by workspace policy: ${policy.reason}`;
    const content = readEditableFile(cwd, filePath);
    if (content === undefined) return `Error: File not found: ${filePath}`;
    assertFileVersion(cwd, filePath, content, expectedVersion, false, context);
    const replacement = replaceUniqueText(content, oldText, newText);
    const updatedContent = replacement.content;
    if (updatedContent === content) {
      return `No changes to ${filePath}`;
    }
    if (updatedContent.includes("\0")) throw new Error("Text file writes cannot contain NUL bytes. Use escaped text (repr or hex) for binary headers, or an approved command tool to generate binary artifacts.");
    const batch = prepareFileMutationBatch([{
      workspaceDir: cwd,
      path: filePath,
      source: "assistant_tool",
      actor: context.actorName,
      runId: context.runId,
      requestId: context.requestId,
      toolCallId: context.toolCallId,
      preimageContent: content,
      postimageContent: updatedContent,
    }], { hunks: true });
    try {
      atomicWriteFile(cwd, filePath, updatedContent, content, { commit: (stat) => batch.commit({ mtimeMs: stat.mtimeMs }) });
    } finally {
      batch.cancel();
    }
    rememberFileWrite(cwd, filePath, updatedContent, context, false);
    return {
      output: `Edited ${filePath}\nversion: ${buildFileVersion(updatedContent)}`,
      fileUpdate: {
        path: filePath,
        content: updatedContent,
        selection: createSelectionRange(
          updatedContent,
          replacement.offset,
          replacement.offset + replacement.replacementLength
        ),
      },
    };
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ---- Dispatch table ----

export const TOOL_DISPATCH: Record<string, ToolHandler> = {
  process_start: (args, ctx) => executeProcessTool("process_start", args, ctx),
  process_poll: (args, ctx) => executeProcessTool("process_poll", args, ctx),
  process_input: (args, ctx) => executeProcessTool("process_input", args, ctx),
  process_stop: (args, ctx) => executeProcessTool("process_stop", args, ctx),
  ask_user: async (args, ctx) => {
    if (ctx.lineage && ctx.lineage.parentRunId !== ctx.runId) return "Error: Ask the primary agent to collect the user's answer.";
    try {
      return await requestAgentQuestion({
        workspaceDir: ctx.workspaceDir, owner: ctx.actorName || "",
        runId: ctx.runId || "", requestId: ctx.requestId || "",
        toolCallId: ctx.toolCallId || "", conversationId: ctx.conversationId || "",
        questions: args.questions, signal: ctx.signal,
      });
    } catch (error) { return `Error: ${error instanceof Error ? error.message : "Question failed"}`; }
  },
  compress: async () =>
    "Context compaction requested. The agent will summarize the conversation before continuing.",

  read_run_evidence: async (args, ctx) =>
    readRunEvidence(args, ctx),

  memory_read: async (args, ctx) =>
    readMemory(ctx.workspaceDir, args.scope),

  memory_write: async (args, ctx) =>
    writeMemory(ctx.workspaceDir, args.scope, args.content),

  skill_load: async (args, ctx) =>
    loadWorkspaceSkill(ctx.workspaceDir, args.name),

  submit_plan: async (args, ctx) => {
    if (ctx.mode !== "plan" || !ctx.conversationId || !ctx.runId) {
      return "Error: submit_plan is only available during an auditable Plan run";
    }
    const plan = createApprovedExecutionPlan(ctx.workspaceDir, args, {
      conversationId: ctx.conversationId,
      planRunId: ctx.runId,
    });
    return JSON.stringify({
      approved: true,
      planId: plan.id,
      goal: plan.goal,
      files: plan.files,
      verificationCommands: plan.verificationCommands,
    }, null, 2);
  },

  submit_completion_evidence: async (args, _ctx) =>
    JSON.stringify({ accepted: true, criterionEvidence: args.criterionEvidence || args.criteria || {} }),

  report_review_finding: async (args, ctx) => {
    if (ctx.mode !== "review") return "Error: report_review_finding is only available in Review mode";
    const result = sanitizeReviewFinding(args, ctx.workspaceDir);
    return "error" in result
      ? `Error: report_review_finding ${result.error}`
      : JSON.stringify(result.finding);
  },

  request_plan_amendment: async (args) => {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const requestedFiles = normalizeNonEmptyStringArray(args.requestedFiles);
    const requestedVerificationCommands = normalizeNonEmptyStringArray(
      args.requestedVerificationCommands
    );
    if (!reason) return "Error: request_plan_amendment requires a non-empty reason";
    if (requestedFiles.length === 0 && requestedVerificationCommands.length === 0) {
      return "Error: request_plan_amendment requires at least one requested file or verification command";
    }
    return JSON.stringify({
      accepted: true,
      reason,
      requestedFiles,
      requestedVerificationCommands,
    });
  },

  bash: async (args, ctx) => {
    const command = typeof args.command === "string" ? args.command : "";
    if (ctx.readOnlyShellCommand !== undefined && (command !== ctx.readOnlyShellCommand || args.allow_network === true)) return "Error: Read-only command changed after authorization";
    if (args.allow_network !== true && planReadOnlyShell(command)) {
      return runReadOnlyShellCommand(command, ctx.workspaceDir, ctx.signal, { readPaths: ctx.filesystemSandbox?.readPaths || [], writePaths: [] });
    }
    if (ctx.readOnlyShellCommand !== undefined) return "Error: Read-only authorization cannot run a writable shell";
    let networkExecutionGrant;
    try { networkExecutionGrant = networkGrantForTool(ctx, args); }
    catch (error) { return `Error: ${error instanceof Error ? error.message : "Network opt-in denied"}`; }
    if (ctx.mode === "code" && (ctx.runId || ctx.requestId) && pendingAgentProcesses(ctx, true).some((process) => process.session.status === "running")) return "Error: Poll or stop the active Agent process before executing another workspace command";
    return ctx.mode === "review" || ctx.mode === "plan"
      ? runInspectionCommand(args.command as string, ctx.workspaceDir, ctx.signal, {
          readPaths: ctx.filesystemSandbox?.readPaths || [], writePaths: [],
        })
      : runWorkspaceCommand(args.command as string, ctx.workspaceDir, ctx.signal, {
      compatibilityShellAuthorized: ctx.compatibilityShellAuthorized === true,
      networkExecutionGrant,
      filesystem: {
        workspaceDir: ctx.workspaceDir,
        readPaths: ctx.filesystemSandbox?.readPaths || [],
        writePaths: ctx.filesystemSandbox?.writePaths || [],
      },
    });
  },

  read_file: async (args, ctx) =>
    runReadFile(args.path as string, args.limit as number | undefined, ctx.workspaceDir, args, ctx),

  find_files: async (args, ctx) => executeRepositoryInspectionTool("find_files", args, ctx.workspaceDir, ctx.signal),
  search_files: async (args, ctx) => executeRepositoryInspectionTool("search_files", args, ctx.workspaceDir, ctx.signal),
  list_directory: async (args, ctx) => executeRepositoryInspectionTool("list_directory", args, ctx.workspaceDir, ctx.signal),

  write_file: async (args, ctx) =>
    runWriteFile(
      args.path as string,
      args.content as string,
      ctx.workspaceDir,
      ctx,
      args.expected_version
    ),

  edit_file: async (args, ctx) =>
    runEditFile(
      args.path as string,
      args.old_text as string,
      args.new_text as string,
      ctx.workspaceDir,
      ctx,
      args.expected_version
    ),

  rename_file: async (args, ctx) => {
    const result = renameWorkspaceFile({ workspaceDir: ctx.workspaceDir, source_path: args.source_path, target_path: args.target_path, expected_version: args.expected_version }, ctx);
    return {
      output: JSON.stringify({ source_path: result.sourcePath, path: result.path, version: result.version, renamed: result.changed }),
      ...(result.changed ? { fileUpdate: { path: result.path, previousPath: result.sourcePath, previousVersion: result.version, content: result.content } } : {}),
    };
  },

  TodoWrite: async (args, ctx) =>
    ctx.todoManager.update(args.items as unknown[]),

  // --- Task tools ---
  task_create: async (args, ctx) =>
    ctx.taskManager.create(args.subject as string, (args.description as string) || ""),

  task_get: async (args, ctx) =>
    ctx.taskManager.get(args.task_id as number),

  task_update: async (args, ctx) => {
    const taskId = args.task_id as number;
    const coordinationRoot = ctx.taskManager.workspaceRoot;
    const runId = ctx.runId || `task-${taskId}`; const scopeId = `task:${taskId}`;
    const attemptToken = args.status === "completed" ? beginCompletionAttempt({ workspaceDir: coordinationRoot, runId, scopeId }) : undefined;
    const gate = attemptToken ? await runRepositoryCompletionGate({ workspaceDir: coordinationRoot, runId, scopeId, attemptToken, agentId: ctx.actorName || "agent" }) : undefined;
    return ctx.taskManager.update(
      taskId,
      args.status as string | undefined,
      args.add_blocked_by as number[] | undefined,
      args.add_blocks as number[] | undefined,
      { completionGateToken: gate?.attemptToken }
    );
  },

  task_list: async (_args, ctx) =>
    ctx.taskManager.listAll(),

  claim_task: async (args, ctx) =>
    ctx.taskManager.claim(args.task_id as number, collaborationActor(ctx)),

  /** Structured, lease-aware task adapter. Legacy task_* tools remain supported. */
  task_command: async (args, ctx) => {
    const action = args.action;
    const taskId = Number(args.task_id);
    const coordinationRoot = ctx.taskManager.workspaceRoot;
    const runId = ctx.runId || `task-${taskId}`; const scopeId = `task:${taskId}`;
    const attemptToken = action === "update" && args.status === "completed" ? beginCompletionAttempt({ workspaceDir: coordinationRoot, runId, scopeId }) : undefined;
    const gate = attemptToken ? await runRepositoryCompletionGate({ workspaceDir: coordinationRoot, runId, scopeId, attemptToken, agentId: ctx.actorName || "agent" }) : undefined;
    return idempotentCommand(ctx, args.idempotency_key, () => {
      if (action === "create") return ctx.taskManager.create(String(args.subject || ""), String(args.description || ""));
      if (action === "get") return JSON.stringify(ctx.taskManager.getTask(taskId));
      if (action === "list") return JSON.stringify(ctx.taskManager.listTasks());
      if (action === "update") return ctx.taskManager.update(taskId, args.status as string | undefined, args.add_blocked_by as number[] | undefined, args.add_blocks as number[] | undefined, { evidence: args.evidence as string[] | undefined, expectedVersion: args.expected_version as number | undefined, completionGateToken: gate?.attemptToken });
      if (action === "claim") return JSON.stringify({ lease: ctx.taskManager.claimLease(taskId, String(args.owner || ctx.actorName || "lead"), Number(args.lease_ms) || 30_000, args.expected_version as number | undefined) });
      if (action === "renew") return JSON.stringify({ renewed: ctx.taskManager.renewLease(taskId, String(args.owner || ctx.actorName || "lead"), String(args.lease_token || ""), Number(args.lease_ms) || 30_000) });
      if (action === "release_expired") return JSON.stringify({ released: ctx.taskManager.releaseExpiredLeases() });
      return JSON.stringify({ error: "unknown task command" });
    });
  },

  /** Structured durable message adapter. lease and ack require their returned token. */
  message_command: async (args, ctx) => idempotentCommand(ctx, args.idempotency_key, () => {
    const action = args.action;
    const agent = String(args.agent || ctx.actorName || "lead");
    if (action === "send") return ctx.messageBus.send(agent, String(args.to || ""), String(args.content || ""), String(args.msg_type || "message"), { idempotencyKey: args.idempotency_key });
    if (action === "lease") {
      const leased = ctx.messageBus.leaseInbox(agent, String(args.consumer || agent), Number(args.limit) || 50, Number(args.lease_ms) || 30_000);
      for (const { message } of leased) if (message.id) new TraceStore(ctx.workspaceDir).appendCollaboration({ action: "message_leased", outcome: "succeeded", messageId: message.id, targetAgentId: agent, ...collaborationReferences(ctx) });
      return JSON.stringify(leased);
    }
    if (action === "ack") {
      const messageId = String(args.message_id || "");
      const acked = ctx.messageBus.ack(agent, messageId, String(args.lease_token || ""));
      new TraceStore(ctx.workspaceDir).appendCollaboration({ action: "message_acked", outcome: acked ? "succeeded" : "rejected", messageId, targetAgentId: agent, ...collaborationReferences(ctx) });
      return JSON.stringify({ acked });
    }
    if (action === "reclaim_expired") {
      const reclaimed = ctx.messageBus.reclaimExpired();
      if (reclaimed) new TraceStore(ctx.workspaceDir).appendCollaboration({ action: "message_lease_expired", outcome: "expired", reasonCode: "lease_expired", count: reclaimed, targetAgentId: agent, ...collaborationReferences(ctx) });
      return JSON.stringify({ reclaimed });
    }
    if (action === "list") return JSON.stringify(ctx.messageBus.list(typeof args.agent === "string" ? args.agent : undefined));
    return JSON.stringify({ error: "unknown message command" });
  }),

  // --- Subagent ---
  task: async (args, ctx) => {
    const parentTaskId = Number.isSafeInteger(args.parent_task_id) && Number(args.parent_task_id) > 0 ? Number(args.parent_task_id) : undefined;
    if (parentTaskId) ctx.taskManager.getTask(parentTaskId);
    return runSubagent(
      args.prompt as string,
      args.agent_type === undefined ? "explore" : String(args.agent_type),
      ctx.workspaceDir,
      ctx.vllmApiUrl,
      ctx.modelName,
      ctx.vllmApiKey,
      ctx.authorizeTool,
      ctx.signal,
      ctx.lineage && {
        ...ctx.lineage,
        ...(parentTaskId ? { parentTaskId } : {}),
      },
      { tools: ctx.delegatedTools || getAllTools({ mode: ctx.mode }), context: ctx }
    );
  },

  // --- Team tools ---
  spawn_teammate: async (args, ctx) => {
    const parentTaskId = Number.isSafeInteger(args.parent_task_id) && Number(args.parent_task_id) > 0 ? Number(args.parent_task_id) : undefined;
    if (parentTaskId) ctx.taskManager.getTask(parentTaskId);
    return ctx.teammateManager.spawn(
      args.name as string,
      args.role as string,
      args.prompt as string,
      ctx.authorizeTool,
      ctx.signal,
      ctx.lineage && {
        ...ctx.lineage,
        ...(parentTaskId ? { parentTaskId } : {}),
      },
      ctx.modelName
    );
  },

  list_teammates: async (_args, ctx) =>
    ctx.teammateManager.listAll(),

  send_message: async (args, ctx) =>
    ctx.messageBus.send(collaborationActor(ctx), args.to as string, args.content as string, (args.msg_type as string) || "message"),

  read_inbox: async (_args, ctx) =>
    JSON.stringify(ctx.messageBus.readInbox(collaborationActor(ctx)), null, 2),

  broadcast: async (args, ctx) =>
    ctx.messageBus.broadcast(collaborationActor(ctx), args.content as string, ctx.teammateManager.memberNames()),

  shutdown_request: async (args, ctx) => {
    const teammate = args.teammate as string;
    ctx.messageBus.send(collaborationActor(ctx), teammate, "Please shut down.", "shutdown_request");
    return `Shutdown request sent to '${teammate}'`;
  },
};

// ---- Tool definitions (OpenAI function-calling format) ----

export const CORE_TOOLS: OpenAIToolDef[] = [
  { type: "function", function: { name: "process_start", description: "Start an approved long-running workspace command. Network is denied by default. allow_network requires two administrator grants and one-time approval or user-enabled full access for unrestricted egress. Returns immediately with an id; poll until a real final exit status. Other workspace mutation tools are blocked while it runs. Code mode only.", parameters: { type: "object", properties: { command: { type: "string", description: "Command subject to ordinary bash policy and approved-plan scope" }, allow_network: { type: "boolean", default: false, description: "Explicitly request unrestricted network access for this command; main Code Agent only, never approved by Plan or ordinary session reuse. Full access is verified by the server, never enabled by tool arguments." }, timeout_ms: { type: "integer", minimum: 100, maximum: 86400000, description: "Wall timeout, defaults to 10 minutes" } }, required: ["command"] } } },
  { type: "function", function: { name: "process_poll", description: "Read output after cursor and actual process status for a session owned by this run. Running is not success. Poll until exited, failed, cancelled or timed_out before completing.", parameters: { type: "object", properties: { session_id: { type: "string" }, cursor: { type: "integer", minimum: 0 } }, required: ["session_id"] } } },
  { type: "function", function: { name: "process_input", description: "Send explicit input to this run's process. Requires a separate one-time approval or user-enabled full access, plus a command-policy check; an approved plan does not authorize interactive input.", parameters: { type: "object", properties: { session_id: { type: "string" }, text: { type: "string", description: "Input bytes (at most 16 KiB)" }, eof: { type: "boolean", description: "Close standard input after writing" } }, required: ["session_id"] } } },
  { type: "function", function: { name: "process_stop", description: "Idempotently request cancellation of this run's process. Poll until termination; a stop request is not yet a final exit status.", parameters: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] } } },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Ask the user one to three consequential clarification questions and wait for their answer. Use only when missing information materially changes the result. This does not grant tool permissions. Child agents should ask their primary agent instead.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array", minItems: 1, maxItems: 3,
            items: { type: "object", properties: {
              prompt: { type: "string" },
              options: { type: "array", items: { type: "string" }, maxItems: 6 },
              multiple: { type: "boolean" },
            }, required: ["prompt"] },
          },
        },
        required: ["questions"],
      },
    },
  },
  ...REPOSITORY_INSPECTION_TOOLS,
  {
    type: "function",
    function: {
      name: "read_run_evidence",
      description: "Read bounded, data-only evidence for the current run. Uses the server-provided current run and conversation only; does not accept run ids, paths, shell commands, or regex. Views: summary, tools, transcript.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          view: { type: "string", enum: ["summary", "tools", "transcript"], default: "summary" },
          offset: { type: "integer", minimum: 0, description: "Item offset for tools, character offset for transcript" },
          limit: { type: "integer", minimum: 1, maximum: 20000, description: "Maximum tools or transcript characters; tool lists are capped server-side" },
          query: { type: "string", maxLength: 200, description: "Literal substring filter or seek; regex is not supported" },
          transcript_index: { type: "integer", minimum: 0, description: "Index from the current run context_compacted transcript references" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report_review_finding",
      description: "Record one machine-readable review finding. Critical and error findings require direct evidence or a reproduction.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["critical", "error", "warning", "info"] },
          lens: { type: "string", enum: ["correctness", "security", "performance", "test", "api_contract", "maintainability"] },
          path: { type: "string", minLength: 1, maxLength: 1000, description: "Safe workspace-relative file path" },
          line: { type: "integer", minimum: 1, maximum: 10000000 },
          column: { type: "integer", minimum: 1, maximum: 1000000 },
          message: { type: "string", minLength: 1, maxLength: 4000 },
          evidence: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2000 } },
          reviewedRevision: { type: "string", minLength: 1, maxLength: 160 },
          reproduction: { type: "string", maxLength: 2000 },
        },
        required: ["severity", "lens", "path", "line", "message", "evidence", "reviewedRevision"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_plan_amendment",
      description: "Request an amendment to the approved execution plan when required work exceeds its file or verification-command scope. This records no workspace state.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            minLength: 1,
            pattern: "\\S",
            description: "Why the approved plan must be amended",
          },
          requestedFiles: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1, pattern: "\\S" },
            description: "Additional relative file or directory scope requested",
          },
          requestedVerificationCommands: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1, pattern: "\\S" },
            description: "Additional exact verification commands requested",
          },
        },
        required: ["reason"],
        anyOf: [
          { required: ["requestedFiles"] },
          { required: ["requestedVerificationCommands"] },
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_completion_evidence",
      description: "Submit explicit acceptance-criterion evidence by mapping each exact criterion text or zero-based index to prior successful tool-call ids. This records no workspace state.",
      parameters: {
        type: "object",
        properties: {
          criterionEvidence: {
            type: "object",
            description: "Keys are exact acceptance criterion text or zero-based indexes; values are successful prior tool-call id arrays.",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
        },
        required: ["criterionEvidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_plan",
      description: "Submit the final structured implementation plan for explicit user approval. Plan mode must call this before finishing.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The exact outcome the implementation must achieve" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Complete relative file or directory scope that Code mode may modify",
          },
          steps: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          verification_commands: {
            type: "array",
            items: { type: "string" },
            description: "Exact shell commands Code mode may execute for verification",
          },
          acceptance_criteria: { type: "array", items: { type: "string" } },
        },
        required: [
          "goal",
          "files",
          "steps",
          "risks",
          "verification_commands",
          "acceptance_criteria",
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compress",
      description: "Compact the current conversation context before continuing the task.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_read",
      description: "Read durable user or workspace memory. Use scope 'user' for preferences and 'workspace' for project conventions.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "workspace"] },
        },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Persist concise durable preferences, project conventions, or decisions. Never store secrets or transient task output.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "workspace"] },
          content: { type: "string", description: "Complete replacement Markdown content for the memory file" },
        },
        required: ["scope", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_load",
      description: "Load the full body of a relevant workspace SKILL.md workflow before following it.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the Workspace Skills catalog" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace directory with network denied by default. allow_network requires administrator grants and an explicit one-time approval or user-enabled full access verified by the server.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command to execute" }, allow_network: { type: "boolean", default: false, description: "Explicit unrestricted network request; primary Code Agent only, one-time approval or existing server-verified full access required. This flag cannot enable full access." } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a versioned text file page. Workspace text can later be edited; external ordinary files inside server-authorized roots are read-only. Safe workspace binary files return read-only size/SHA256 metadata without content or an editable version; metadata is not verification evidence. NUL-contaminated text is rejected with regeneration guidance. Text pages are bounded to 50,000 characters and file content policy still applies. Never write metadata into files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path, or an explicit absolute path to an authorized external read-only file; parent traversal is not accepted" },
          limit: { type: "integer", minimum: 1, description: "Maximum lines to read; character budget may shorten the page" },
          offset: { type: "integer", minimum: 0, description: "Zero-based line offset. Use only one of offset, start_line, or character_offset" },
          start_line: { type: "integer", minimum: 1, description: "One-based starting line (alternative to offset)" },
          character_offset: { type: "integer", minimum: 0, description: "Exact UTF-16 character offset returned in next_character_offset, including continuation within a long line" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a regular file inside the workspace without overwriting a target. Read the complete source first or supply expected_version. Both paths must be workspace-relative; directories, links, external paths and existing targets are refused. The rename is recorded for review and undo.",
      parameters: {
        type: "object",
        properties: {
          source_path: { type: "string", description: "Existing workspace-relative file path" },
          target_path: { type: "string", description: "New workspace-relative path; parent directory must exist and target must not exist" },
          expected_version: { type: "string", description: "Source version from read_file, optional after a complete read in this run" },
        },
        required: ["source_path", "target_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Atomically write a complete file (creates parent directories). Existing files require a complete read by this agent in this run or an explicit expected_version. Fails if the file changed since reading; reconcile changes before retrying.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from workspace root" },
          content: { type: "string", description: "Full file content" },
          expected_version: { type: "string", description: "Version returned by read_file or the last successful edit/write; 'missing' requires a new file. Optional when this agent has read the complete current file in this run" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Atomically replace exactly one occurrence of old_text with literal new_text. Read the file first or supply expected_version. Rejects empty or ambiguous matches and stale reads. Only uniform LF/CRLF differences are normalized; include enough context to locate one match.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path" },
          old_text: { type: "string", description: "Exact text to find" },
          new_text: { type: "string", description: "Replacement text" },
          expected_version: { type: "string", description: "Version returned by read_file or the last successful edit/write. Optional when this agent has read the current file in this run" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description: "Update the task tracking checklist. Max 20 items, max 1 in_progress.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                activeForm: { type: "string" },
              },
              required: ["content", "status", "activeForm"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
];

export const TASK_TOOLS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "task_command",
      description: "Run a structured task command. Claims return a lease token; renewals require that token. Supplying idempotency_key makes retries safe.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["create", "get", "list", "update", "claim", "renew", "release_expired"] },
        task_id: { type: "integer" }, subject: { type: "string" }, description: { type: "string" }, status: { type: "string" },
        owner: { type: "string" }, lease_token: { type: "string" }, lease_ms: { type: "integer" }, expected_version: { type: "integer" },
        add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } },
        evidence: { type: "array", items: { type: "string" } }, idempotency_key: { type: "string" },
      }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "task_create",
      description: "Create a persistent file task.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          description: { type: "string" },
        },
        required: ["subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_get",
      description: "Get task details by ID.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "integer" } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_update",
      description: "Update task status or dependencies.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "integer" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
          add_blocked_by: { type: "array", items: { type: "integer" } },
          add_blocks: { type: "array", items: { type: "integer" } },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_list",
      description: "List all tasks.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "claim_task",
      description: "Claim a task from the board.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "integer" } },
        required: ["task_id"],
      },
    },
  },
];

export const TEAM_TOOLS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "message_command",
      description: "Run a durable message command. Leasing returns message lease tokens; ack requires the matching token. idempotency_key makes sends retry-safe.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["send", "lease", "ack", "reclaim_expired", "list"] }, agent: { type: "string" }, to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string" },
        consumer: { type: "string" }, limit: { type: "integer" }, lease_ms: { type: "integer" }, message_id: { type: "string" }, lease_token: { type: "string" }, idempotency_key: { type: "string" },
      }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "task",
      description: "Delegate an isolated task and wait for its summary. Choose general for implementation with available tools, explore for read-only repository reconnaissance, review for correctness and regression review, or planner for investigation and an implementation plan. Legacy Explore and general-purpose names remain accepted.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          agent_type: { type: "string", enum: [...SUBAGENT_ROLES, "Explore", "general-purpose"], default: "explore" },
          parent_task_id: { type: "integer", description: "Optional durable parent task binding." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_teammate",
      description: "Spawn a persistent autonomous teammate.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          prompt: { type: "string" },
          parent_task_id: { type: "integer", description: "Optional durable parent task binding." },
        },
        required: ["name", "role", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_teammates",
      description: "List all teammates and their status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Send a message to a teammate.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          content: { type: "string" },
          msg_type: { type: "string", enum: ["message", "broadcast", "shutdown_request"] },
        },
        required: ["to", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_inbox",
      description: "Read and drain the lead agent's inbox.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "broadcast",
      description: "Send message to all teammates.",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shutdown_request",
      description: "Request a teammate to shut down.",
      parameters: {
        type: "object",
        properties: { teammate: { type: "string" } },
        required: ["teammate"],
      },
    },
  },
];

export const MCP_CONTROL_TOOLS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_lazy_mcp_tools",
      description: "Search hidden lazy MCP tools by capability before exposing them to the model.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Capability or tool keyword to search for" },
          endpoint_key: { type: "string", description: "Optional endpoint key to narrow the search" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_lazy_mcp_tools",
      description: "Expose selected tools from one lazy MCP endpoint for the next reasoning round.",
      parameters: {
        type: "object",
        properties: {
          endpoint_key: { type: "string", description: "Endpoint key returned by search_lazy_mcp_tools" },
          tool_names: { type: "array", items: { type: "string" }, description: "Exact MCP tool names to activate" },
        },
        required: ["endpoint_key", "tool_names"],
      },
    },
  },
];

const READ_ONLY_TOOL_NAMES = new Set(["compress", "read_run_evidence", "memory_read", "skill_load", "read_file", "find_files", "search_files", "list_directory", "TodoWrite", "ask_user"]);

export function getAllTools(options?: {
  readOnly?: boolean;
  mode?: "ask" | "code" | "review" | "plan";
  constrainedCode?: boolean;
}): OpenAIToolDef[] {
  const allTools = [...CORE_TOOLS, ...TASK_TOOLS, ...TEAM_TOOLS];
  if (options?.mode === "code" && options.constrainedCode && !options.readOnly) {
    const codeContractTools = new Set([
      "ask_user",
      "compress",
      "read_run_evidence",
      "memory_read",
      "skill_load",
      "read_file",
      "find_files",
      "search_files",
      "list_directory",
      "TodoWrite",
      "bash",
      "process_start", "process_poll", "process_input", "process_stop",
      "write_file",
      "edit_file",
      "rename_file",
      "submit_completion_evidence",
      "request_plan_amendment",
    ]);
    return allTools.filter((tool) => codeContractTools.has(tool.function.name));
  }
  if (!options?.readOnly && options?.mode !== "ask" && options?.mode !== "review" && options?.mode !== "plan") {
    return allTools.filter((tool) =>
      tool.function.name !== "request_plan_amendment" && tool.function.name !== "report_review_finding"
    );
  }
  return allTools.filter((tool) =>
    READ_ONLY_TOOL_NAMES.has(tool.function.name) ||
    ((options?.mode === "review" || options?.mode === "plan") && tool.function.name === "bash") ||
    (options?.mode === "review" && tool.function.name === "report_review_finding") ||
    (options?.mode === "plan" && tool.function.name === "submit_plan")
  );
}
