import path from "node:path";
import fs from "node:fs";
import { createCheckpoint } from "../chat/checkpoints.js";
import { captureCheckpointMutationsDetailed, subscribeWorkspaceMutations } from "../files/mutationRegistry.js";
import { inputProcessSession, pollProcessSession, startAgentProcessSession, stopProcessSession, type ProcessSessionOwner, type ProcessSessionSummary } from "../run/processSessions.js";
import { evaluateShellCommand } from "./toolPolicy.js";
import type { ToolContext } from "./types.js";
import { evaluateInspectionCommand } from "./modeCapabilities.js";
import { TraceStore } from "../chat/traceStore.js";
import { networkGrantForTool } from "./networkAccess.js";

export interface AgentProcessResult {
  session: ProcessSessionSummary;
  command: string;
  checkpointId?: string;
  toolCallId?: string;
  evidenceError?: string;
  output: string;
  truncated: boolean;
}
interface Binding {
  owner: ProcessSessionOwner;
  command: string;
  checkpointId: string;
  toolCallId: string;
  requestId?: string;
  actor?: string;
  conflicts: Set<string>;
  auditing: boolean;
  audited: boolean;
  evidenceError?: string;
}
const bindings = new Map<string, Binding>();
type ProcessOwnerContext = Pick<ToolContext, "workspaceDir" | "runId" | "requestId" | "actorName" | "sessionOwner" | "sessionToken">;

export function agentProcessOwner(context: ProcessOwnerContext): ProcessSessionOwner {
  const runId = context.runId || context.requestId;
  if (!runId) throw new Error("Process tools require an auditable run id");
  return { workspaceDir: context.workspaceDir, owner: context.sessionOwner || context.actorName || "primary", runId, sessionToken: context.sessionToken };
}
function sameWorkspace(a: string, b: string): boolean {
  const canonical = (value: string) => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
  return canonical(a) === canonical(b);
}
function ownBinding(context: ToolContext, id: string): Binding | undefined {
  const owner = agentProcessOwner(context);
  const binding = bindings.get(id);
  if (binding && (!sameWorkspace(binding.owner.workspaceDir, owner.workspaceDir) || binding.owner.owner !== owner.owner || binding.owner.runId !== owner.runId)) throw new Error("Process session not found");
  return binding;
}

subscribeWorkspaceMutations((event) => {
  for (const binding of bindings.values()) {
    if (!binding.audited && !binding.auditing && sameWorkspace(binding.owner.workspaceDir, event.workspaceDir)) binding.conflicts.add(event.path);
  }
});

function finalize(id: string, binding: Binding): void {
  if (binding.audited) return;
  binding.auditing = true;
  try {
    if (binding.conflicts.size) throw new Error(`Concurrent workspace edits prevent safe attribution of process changes: ${[...binding.conflicts].slice(0, 20).join(", ")}`);
    const captured = captureCheckpointMutationsDetailed(binding.owner.workspaceDir, {
      checkpointId: binding.checkpointId, runId: binding.owner.runId!, requestId: binding.requestId,
      toolCallId: binding.toolCallId, actor: binding.actor,
    });
    if (captured.skipped.length) throw new Error(`Process mutation evidence is incomplete: ${captured.skipped.map((entry) => `${entry.path}:${entry.reason}`).join(", ")}`);
  } catch (error) {
    binding.evidenceError = error instanceof Error ? error.message : String(error);
  } finally {
    binding.audited = true;
    binding.auditing = false;
  }
  try { if (fs.existsSync(binding.owner.workspaceDir)) new TraceStore(binding.owner.workspaceDir).append({ kind: "validation", action: "Agent process mutation audit", correlationId: binding.owner.runId || id, runId: binding.owner.runId, requestId: binding.requestId, toolCallId: binding.toolCallId, decision: binding.evidenceError ? "blocked" : "recorded", evidence: binding.evidenceError, metadata: { processId: id, checkpointId: binding.checkpointId } }); } catch { /* The mutation journal remains the authoritative successful capture. */ }
  // Keep terminal records available for bounded repeat polling.
  if (bindings.size > 256) for (const [key, item] of bindings) if (key !== id && item.audited) { bindings.delete(key); if (bindings.size <= 256) break; }
}

export function pendingAgentProcesses(context: ProcessOwnerContext, acrossRuns = false, includeCompleted = false): AgentProcessResult[] {
  const owner = agentProcessOwner(context);
  const results: AgentProcessResult[] = [];
  for (const [id, binding] of bindings) {
    if (!sameWorkspace(binding.owner.workspaceDir, context.workspaceDir) || (!acrossRuns && (binding.owner.owner !== owner.owner || binding.owner.runId !== owner.runId))) continue;
    try {
      const state = pollProcessSession(binding.owner, id);
      if (state.session.status !== "running" && !binding.audited) finalize(id, binding);
      if (includeCompleted || state.session.status === "running" || binding.evidenceError) results.push({ session: state.session, command: binding.command, checkpointId: binding.checkpointId, toolCallId: binding.toolCallId, evidenceError: binding.evidenceError, output: state.events.map((event) => event.text).join(""), truncated: state.truncated });
    } catch (error) {
      binding.evidenceError = error instanceof Error ? error.message : String(error);
      results.push({ session: { id, taskId: "agent:command", label: binding.command, status: "interrupted", startedAt: 0, exitCode: null, nextCursor: 0, runId: binding.owner.runId }, command: binding.command, evidenceError: binding.evidenceError, output: "", truncated: false });
    }
  }
  return results;
}

export async function executeProcessTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<{ output: string; process: AgentProcessResult }> {
  if (context.mode !== "code") throw new Error("Process session tools are only available in Code mode");
  if ((context.subagentDepth || 0) > 0 || context.agentProfileId === "subagent" || context.agentProfileId === "teammate") throw new Error("Long-running process tools are available only to the primary Agent; delegated agents must use their existing bounded bash tool");
  const owner = agentProcessOwner(context);
  if ((name === "process_start" || name === "process_input") && context.compatibilityShellAuthorized !== true) throw new Error("Process execution/input requires the approved tool permission path");
  if (name === "process_start") {
    const networkExecutionGrant = networkGrantForTool(context, args);
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command || command.length > 16_000) throw new Error("A bounded command is required");
    const policy = evaluateShellCommand(command, { compatibilityShellAuthorized: true, workspaceDir: context.workspaceDir, networkAccessAuthorized: Boolean(networkExecutionGrant) });
    if (!policy.allowed) throw new Error(`Command blocked by workspace policy: ${policy.reason}`);
    if (context.executionPlan && !context.executionPlan.verificationCommands.includes(command) && !evaluateInspectionCommand(command).allowed) throw new Error("Process command is outside the approved execution plan");
    if (pendingAgentProcesses(context, true).some((item) => item.session.status === "running")) throw new Error("Wait for the current workspace Agent process to finish before starting another");
    const checkpointId = context.stepCheckpointId || createCheckpoint(context.workspaceDir, { label: `Before Agent process · ${command.slice(0, 80)}`, runId: owner.runId, conversationId: context.conversationId, kind: "step", toolCallId: context.toolCallId }).id;
    const binding: Binding = { owner, command, checkpointId, toolCallId: context.toolCallId || `process-${Date.now()}`, requestId: context.requestId, actor: context.actorName, conflicts: new Set(), auditing: false, audited: false };
    let id = "";
    const session = startAgentProcessSession({
      ...owner, executable: process.platform === "win32" ? "/bin/bash" : "/bin/sh",
      args: ["-c", command],
      timeoutMs: args.timeout_ms as number | undefined, signal: context.signal,
      networkExecutionGrant,
      filesystem: { workspaceDir: context.workspaceDir, readPaths: context.filesystemSandbox?.readPaths || ["."], writePaths: context.filesystemSandbox?.writePaths || ["."] },
      onExit: () => finalize(id, binding),
    });
    id = session.id; bindings.set(id, binding);
    const result = { session, command, checkpointId, toolCallId: binding.toolCallId, output: "", truncated: false };
    return { output: JSON.stringify({ ...result, nextCursor: session.nextCursor, events: [], note: "Process is running; poll for final exit status. A running process is not verification success." }), process: result };
  }
  const id = typeof args.session_id === "string" ? args.session_id : "";
  const binding = ownBinding(context, id);
  // Always check service ownership, including for records loaded after restart.
  pollProcessSession(owner, id);
  if (name === "process_input") {
    if (context.executionPlan) throw new Error("Interactive input requires a plan amendment; an approved command does not authorize new input");
    const text = args.text === undefined ? "" : args.text;
    if (typeof text !== "string") throw new Error("Process input must be a string");
    if (args.eof !== undefined && typeof args.eof !== "boolean") throw new Error("eof must be a boolean");
    if (text.trim()) {
      const policy = evaluateShellCommand(text, { compatibilityShellAuthorized: true, workspaceDir: context.workspaceDir });
      if (!policy.allowed) throw new Error(`Interactive input blocked by workspace policy: ${policy.reason}`);
    }
    await inputProcessSession(owner, id, text, args.eof === true);
  } else if (name === "process_stop") stopProcessSession(owner, id);
  else if (name !== "process_poll") throw new Error("Unknown process tool");
  const state = pollProcessSession(owner, id, args.cursor === undefined ? 0 : args.cursor as number);
  if (state.session.status !== "running" && binding && !binding.audited) finalize(id, binding);
  const result: AgentProcessResult = {
    session: state.session, command: binding?.command || "", checkpointId: binding?.checkpointId, toolCallId: binding?.toolCallId,
    evidenceError: binding?.evidenceError || (!binding ? "Process checkpoint ownership was not retained; this result cannot prove validation after restart" : undefined),
    output: pollProcessSession(owner, id).events.map((event) => event.text).join(""), truncated: state.truncated,
  };
  return { output: JSON.stringify({ ...state, command: result.command, evidenceError: result.evidenceError }), process: result };
}

export async function stopAgentProcesses(context: ProcessOwnerContext): Promise<void> {
  const owner = agentProcessOwner(context);
  for (const result of pendingAgentProcesses(context)) if (result.session.status === "running") stopProcessSession(owner, result.session.id);
}
