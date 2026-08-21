import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { safePath } from "../utils/safePath.js";
import { readAuthorizedWorkspaceFile } from "./contextPolicy.js";
import { OpenAIMessage, OpenAIToolCall, OpenAIToolDef, ToolContext } from "./types.js";
import { evaluateWorkspaceWrite } from "./toolPolicy.js";
import {
  createPermissionAuthorizer,
  narrowPermissionAuthorizer,
  type PermissionAuthorizer,
} from "./permissionService.js";
import { runWorkspaceCommand } from "./shell.js";
import { processModelTurn } from "./modelProcessor.js";
import { bindConfiguredFallbacks, buildProviderExecutionContract } from "./providerRouting.js";
import { AgentRunRecorder, createRunId } from "../chat/runHistory.js";
import {
  estimateUsageCostUsd,
  resolveAgentProfile,
} from "./agentProfiles.js";
import { runAgentHooks } from "./agentHooks.js";
import { requireModelTurnAction } from "./finishReason.js";
import { createCheckpoint } from "../chat/checkpoints.js";
import { estimateMessageTokens } from "./context.js";
import { createManagedWorktree, updateManagedWorktreeMetadata } from "../chat/worktrees.js";
import { captureChangeSet } from "../chat/changeSets.js";
import { TraceStore, type CollaborationEventReferences } from "../chat/traceStore.js";
import { captureCheckpointMutationsDetailed, listMutationEvidenceGaps, recordKnownFileMutation } from "../files/mutationRegistry.js";

const SUB_TOOLS_EXPLORE: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

const SUB_TOOLS_WRITE: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
];

function subRead(filePath: string, cwd: string): string {
  try {
    return readAuthorizedWorkspaceFile(cwd, filePath).content.slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function subWrite(filePath: string, content: string, cwd: string, runId?: string, toolCallId?: string): string {
  const decision = evaluateWorkspaceWrite(filePath);
  if (!decision.allowed) return `Error: ${decision.reason || "Write blocked by workspace policy"}`;
  try {
    const full = safePath(filePath, cwd);
    const previous = fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : "";
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    recordKnownFileMutation({ workspaceDir: cwd, path: filePath, source: "assistant_tool", actor: "subagent", mtimeMs: fs.statSync(full).mtimeMs, content, preimageContent: previous, runId, toolCallId });
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function subEdit(filePath: string, oldText: string, newText: string, cwd: string, runId?: string, toolCallId?: string): string {
  const decision = evaluateWorkspaceWrite(filePath);
  if (!decision.allowed) return `Error: ${decision.reason || "Edit blocked by workspace policy"}`;
  try {
    const full = safePath(filePath, cwd);
    const c = fs.readFileSync(full, "utf-8");
    if (!c.includes(oldText)) return `Error: Text not found in ${filePath}`;
    const content = c.replace(oldText, newText);
    fs.writeFileSync(full, content, "utf-8");
    recordKnownFileMutation({ workspaceDir: cwd, path: filePath, source: "assistant_tool", actor: "subagent", mtimeMs: fs.statSync(full).mtimeMs, content, preimageContent: c, runId, toolCallId });
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function dispatchSubTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  agentName: string,
  authorize: PermissionAuthorizer,
  toolCallId: string,
  onAuthorized?: () => Promise<void>,
  signal?: AbortSignal,
  runId?: string
): Promise<string> {
  const permission = await authorize({
    requestId: agentName,
    toolCallId,
    name,
    input: args,
    agentName,
  });
  if (!permission.allowed) return `Error: Tool denied: ${permission.reason || "permission denied"}`;
  await onAuthorized?.();
  switch (name) {
    case "bash":
      return runWorkspaceCommand(args.command as string, cwd, signal, { compatibilityShellAuthorized: true });
    case "read_file":
      return subRead(args.path as string, cwd);
    case "write_file":
      return subWrite(args.path as string, args.content as string, cwd, runId, toolCallId);
    case "edit_file":
      return subEdit(args.path as string, args.old_text as string, args.new_text as string, cwd, runId, toolCallId);
    default:
      return `Unknown tool: ${name}`;
  }
}

export async function runSubagent(
  prompt: string,
  agentType: string,
  workspaceDir: string,
  vllmApiUrl: string,
  modelName: string,
  vllmApiKey?: string,
  authorizeTool?: PermissionAuthorizer,
  signal?: AbortSignal,
  lineage?: ToolContext["lineage"]
): Promise<string> {
  const profileId = agentType === "Explore" ? "explore" : "subagent";
  const profile = resolveAgentProfile(profileId, config.agentProfiles, {
    modelName,
    maxOutputTokens: config.agentMaxTokens,
  });
  const effectiveModel = profile.modelName || modelName;
  const tools =
    agentType === "Explore"
      ? SUB_TOOLS_EXPLORE
      : [...SUB_TOOLS_EXPLORE, ...SUB_TOOLS_WRITE];

  const messages: OpenAIMessage[] = [{ role: "user", content: prompt }];
  const authorize = authorizeTool
    ? narrowPermissionAuthorizer(authorizeTool, profile)
    : createPermissionAuthorizer({
        mode: "code",
        readOnly: false,
        signal,
        profile,
      });
  const agentName = `subagent:${agentType}`;
  // Bash is intentionally treated as write-capable: command intent cannot be proven
  // read-only before execution, so every subagent receives an isolated checkout.
  let worktree;
  const childRunId = createRunId();
  const traceStore = new TraceStore(workspaceDir);
  const references = (extra: Partial<CollaborationEventReferences> = {}): CollaborationEventReferences => ({
    runId: childRunId,
    agentId: agentName,
    parentRunId: lineage?.parentRunId,
    parentTaskId: lineage?.parentTaskId,
    requestId: lineage?.parentRequestId,
    toolCallId: lineage?.parentToolCallId,
    ...extra,
  });
  traceStore.appendCollaboration({ action: "spawn_requested", outcome: "requested", ...references() });
  traceStore.appendCollaboration({ action: "worktree_capture_requested", outcome: "requested", ...references() });
  try {
    worktree = createManagedWorktree(workspaceDir, {
      name: agentName,
      ownerId: agentName,
      parentRunId: lineage?.parentRunId,
      childRunId,
      toolCallId: lineage?.parentToolCallId,
    });
  } catch (error) {
    traceStore.appendCollaboration({ action: "worktree_capture_failed", outcome: "failed", reasonCode: "allocation_failed", ...references() });
    traceStore.appendCollaboration({ action: "spawn_failed", outcome: "failed", reasonCode: "worktree_unavailable", ...references() });
    return `(subagent: isolated worktree allocation failed; refusing to run: ${error instanceof Error ? error.message : String(error)})`;
  }
  const childWorkspaceDir = worktree.path;
  traceStore.appendCollaboration({ action: "worktree_capture_succeeded", outcome: "succeeded", ...references({ worktreeId: worktree.id }) });
  traceStore.appendCollaboration({ action: "spawn_started", outcome: "started", status: "working", ...references({ worktreeId: worktree.id }) });
  const recorder = lineage
    ? new AgentRunRecorder(
        workspaceDir,
        childRunId,
        lineage.parentConversationId,
        "code",
        undefined,
        {
          parentRunId: lineage.parentRunId,
          parentTaskId: lineage.parentTaskId,
          parentToolCallId: lineage.parentToolCallId,
          parentRequestId: lineage.parentRequestId,
          agentName,
        }
      )
    : undefined;
  await recorder?.start();
  if (recorder && profile.stepSnapshots) {
    try {
      const checkpoint = createCheckpoint(childWorkspaceDir, {
        label: `Before ${agentName}`,
        conversationId: lineage?.parentConversationId,
        runId: recorder.runId,
        kind: "run",
      });
      await recorder.event({
        kind: "tool_result",
        label: "Subagent workspace checkpoint created",
        detail: checkpoint.id,
      });
    } catch (error) {
      await recorder.event({
        kind: "error",
        label: "Subagent workspace checkpoint unavailable",
        isError: true,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let recorderFinished = false;
  let mutationEvidenceBlocker = "";
  const finish = async (
    status: "completed" | "stopped" | "failed",
    output: string
  ): Promise<string> => {
    let changeSetSuffix = "";
    const finalReferences = references({ worktreeId: worktree.id });
    traceStore.appendCollaboration({ action: "change_set_capture_requested", outcome: "requested", ...finalReferences });
    let changeSet: ReturnType<typeof captureChangeSet> | undefined;
    try {
      const mutationEvidenceGaps = listMutationEvidenceGaps(childWorkspaceDir, { runId: childRunId });
      if (mutationEvidenceGaps.length && !mutationEvidenceBlocker) {
        mutationEvidenceBlocker = `Mutation evidence incomplete: ${mutationEvidenceGaps.map((gap) => `${gap.path}:${gap.reason}`).join(", ")}`;
      }
      changeSet = captureChangeSet(workspaceDir, worktree.id, { status, agentName, parentRunId: lineage?.parentRunId, parentTaskId: lineage?.parentTaskId, childRunId, toolCallId: lineage?.parentToolCallId, mutationEvidenceGaps });
      changeSetSuffix = `\nChangeSet ${changeSet.id} (${changeSet.status})`;
      await recorder?.event({ kind: "tool_result", label: "Subagent ChangeSet captured", detail: `${changeSet.id} (${changeSet.status})` });
    } catch (error) {
      updateManagedWorktreeMetadata(workspaceDir, worktree.id, "needs_attention", "pending");
      changeSetSuffix = `\nChangeSet capture failed: ${error instanceof Error ? error.message : String(error)}`;
      mutationEvidenceBlocker ||= `Mutation evidence capture failed: ${error instanceof Error ? error.message : String(error)}`;
      await recorder?.event({ kind: "error", label: "Subagent ChangeSet capture failed", isError: true, detail: changeSetSuffix });
      traceStore.appendCollaboration({ action: "change_set_capture_failed", outcome: "failed", status: "needs_attention", reasonCode: "capture_failed", ...finalReferences });
      traceStore.appendCollaboration({ action: "verification_failed", outcome: "failed", status: "failed", reasonCode: "change_set_unavailable", ...finalReferences });
    }
    if (changeSet) {
      const capturedReferences = { ...finalReferences, changeSetId: changeSet.id };
      traceStore.appendCollaboration({ action: "change_set_capture_succeeded", outcome: "succeeded", status: changeSet.status, ...capturedReferences });
      traceStore.appendCollaboration({ action: "change_set_result", outcome: changeSet.status === "needs_attention" ? "failed" : "succeeded", status: changeSet.status, ...capturedReferences });
      traceStore.appendCollaboration({
        action: mutationEvidenceBlocker || changeSet.status === "needs_attention" ? "verification_failed" : "verification_passed",
        outcome: mutationEvidenceBlocker || changeSet.status === "needs_attention" ? "failed" : "succeeded",
        status: mutationEvidenceBlocker || changeSet.status === "needs_attention" ? "failed" : "passed",
        ...(mutationEvidenceBlocker ? { reasonCode: "mutation_evidence_incomplete" } : {}),
        ...capturedReferences,
      });
    }
    if (recorder && !recorderFinished) {
      recorderFinished = true;
      await recorder.finish(status === "stopped" ? "stopped" : mutationEvidenceBlocker ? "failed" : status);
    }
    const finalStatus = status === "stopped" ? "stopped" : mutationEvidenceBlocker ? "failed" : status;
    traceStore.appendCollaboration({
      action: finalStatus === "stopped" ? "agent_stopped" : "agent_state_transition",
      previousStatus: "working",
      status: finalStatus,
      outcome: finalStatus === "failed" ? "failed" : "succeeded",
      ...(finalStatus === "failed" ? { reasonCode: mutationEvidenceBlocker ? "verification_failed" : "execution_failed" } : {}),
      ...finalReferences,
    });
    const effectiveOutput = mutationEvidenceBlocker && !output.startsWith("Error:")
      ? `Error: ${mutationEvidenceBlocker}${output ? `\n${output}` : ""}`
      : output;
    return `${effectiveOutput}${changeSetSuffix}`;
  };
  let completedNaturally = false;

  const startedAt = Date.now();
  for (let i = 0; i < profile.budget.maxSteps; i++) {
    if (Date.now() - startedAt >= profile.budget.maxDurationMs) {
      return finish("failed", `(subagent: duration budget exceeded after ${profile.budget.maxDurationMs}ms)`);
    }
    const currentMetrics = recorder?.snapshot().metrics;
    if (
      profile.budget.maxCostUsd > 0 &&
      (currentMetrics?.estimatedCostUsd || 0) >= profile.budget.maxCostUsd
    ) {
      return finish("failed", `(subagent: cost budget exceeded at $${profile.budget.maxCostUsd})`);
    }
    await recorder?.event(
      { kind: "model_call", label: "Subagent model request started" },
      {
        iterations: i + 1,
        modelCalls: (currentMetrics?.modelCalls || 0) + 1,
      }
    );
    let data;
    let providerAttempts = 1;
    try {
      const executionContract = buildProviderExecutionContract({
        id: `${profile.id}:isolated-subagent`,
        permissions: profile.permissions.allow,
        isolation: `managed_worktree:${worktree.id}`,
        tools: tools.map((tool) => tool.function.name),
      });
      const processed = await processModelTurn({
        apiUrl: vllmApiUrl,
        apiKey: vllmApiKey,
        model: effectiveModel,
        providerId: profile.providerId,
        messages,
        tools,
        executionContract,
        fallbacks: bindConfiguredFallbacks(config.modelFallbacks, executionContract, profile.budget.maxOutputTokens),
        fallbackMaxOutputTokens: profile.budget.maxOutputTokens,
        maxOutputTokens: profile.budget.maxOutputTokens,
        temperature: 0.3,
        signal,
        hookContext: {
          agentId: profile.id,
          runId: recorder?.runId,
          conversationId: lineage?.parentConversationId,
          requestId: lineage?.parentRequestId,
        },
        contextAudit: {
          storeWorkspaceDir: workspaceDir,
          effectiveWorkspaceDir: childWorkspaceDir,
          scope: {
            kind: "managed_worktree",
            scopeId: worktree.id,
            worktreeId: worktree.id,
            baseSha: worktree.baseSha,
            headSha: worktree.head,
          },
          purpose: "subagent",
          runId: recorder?.runId,
          conversationId: lineage?.parentConversationId,
          requestId: lineage?.parentRequestId,
          agentId: profile.id,
        },
        onContextManifest: async (state) => {
          if (recorder && !recorder.snapshot().contextManifestIds.includes(state.manifestId)) {
            await recorder.attachContextManifest(state.manifestId);
          }
        },
      });
      data = processed.response;
      providerAttempts = processed.attempts;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        await finish("stopped", "");
        signal?.throwIfAborted();
        throw error;
      }
      await recorder?.event({
        kind: "error",
        label: "Subagent model request failed",
        isError: true,
        detail: error instanceof Error ? error.message : String(error),
      }, {
        modelErrors: (currentMetrics?.modelErrors || 0) + 1,
      });
      return finish("failed", "(subagent: LLM request failed)");
    }

    const choice = data.choices?.[0];
    if (!choice) return finish("failed", "(subagent: no response)");
    const usage = data.usage || {};
    const promptTokens = typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : estimateMessageTokens(messages);
    const completionTokens = typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : estimateMessageTokens([{
          role: "assistant",
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        }]);
    const totalTokens = typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : promptTokens + completionTokens;
    const estimatedCostUsd = estimateUsageCostUsd(profile, promptTokens, completionTokens);
    await recorder?.event(
      {
        kind: "model_response",
        label: "Subagent model response received",
        detail: `provider_attempts=${providerAttempts}`,
      },
      {
        promptTokens: (currentMetrics?.promptTokens || 0) + promptTokens,
        completionTokens: (currentMetrics?.completionTokens || 0) + completionTokens,
        totalTokens: (currentMetrics?.totalTokens || 0) + totalTokens,
        estimatedCostUsd: (currentMetrics?.estimatedCostUsd || 0) + estimatedCostUsd,
      }
    );

    const msg = choice.message;
    let turnAction: ReturnType<typeof requireModelTurnAction>;
    try {
      turnAction = requireModelTurnAction(choice);
    } catch (error) {
      await recorder?.event({
        kind: "error",
        label: "Subagent response did not finish cleanly",
        isError: true,
        detail: error instanceof Error ? error.message : String(error),
      });
      return finish(
        "failed",
        `(subagent: ${error instanceof Error ? error.message : String(error)})`
      );
    }
    messages.push({
      role: "assistant",
      content: msg.content,
      tool_calls: msg.tool_calls,
    });

    if (turnAction === "stop") {
      completedNaturally = true;
      break;
    }

    for (const tc of msg.tool_calls as OpenAIToolCall[]) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      const toolMetrics = recorder?.snapshot().metrics;
      await recorder?.toolState({
        toolCallId: tc.id,
        requestId: lineage?.parentRequestId || agentName,
        name: tc.function.name,
        toolInput: args,
        status: "pending",
      });
      await recorder?.event(
        { kind: "tool_call", label: "Subagent tool execution started", toolName: tc.function.name },
        { toolCalls: (toolMetrics?.toolCalls || 0) + 1 }
      );
      let output: string;
      let snapshotId: string | undefined;
      let bashMutationsCaptured = false;
      let mutationEvidenceFailure = "";
      const captureBashMutations = async (): Promise<void> => {
        if (tc.function.name !== "bash" || !snapshotId || bashMutationsCaptured) return;
        bashMutationsCaptured = true;
        try {
          const capture = captureCheckpointMutationsDetailed(childWorkspaceDir, {
            checkpointId: snapshotId,
            runId: childRunId,
            toolCallId: tc.id,
            actor: agentName,
          });
          if (capture.skipped.length) {
            mutationEvidenceFailure = `Mutation evidence incomplete: ${capture.skipped.map((entry) => `${entry.path}:${entry.reason}`).join(", ")}`;
            mutationEvidenceBlocker ||= mutationEvidenceFailure;
          }
        } catch (error) {
          mutationEvidenceFailure = `Mutation journal unavailable: ${error instanceof Error ? error.message : String(error)}`;
          mutationEvidenceBlocker ||= mutationEvidenceFailure;
          await recorder?.event({
            kind: "error",
            label: "Subagent bash mutation capture failed",
            toolName: tc.function.name,
            isError: true,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      };
      try {
        if ((toolMetrics?.toolCalls || 0) >= profile.budget.maxToolCalls) {
          throw new Error(`Agent tool-call budget exceeded (${profile.budget.maxToolCalls})`);
        }
        await recorder?.toolState({
          toolCallId: tc.id,
          requestId: lineage?.parentRequestId || agentName,
          name: tc.function.name,
          status: "awaiting_permission",
        });
        output = await dispatchSubTool(
          tc.function.name,
          args,
          childWorkspaceDir,
          agentName,
          authorize,
          tc.id,
          async () => {
            if (["bash", "write_file", "edit_file"].includes(tc.function.name)) {
              try {
                const checkpoint = createCheckpoint(childWorkspaceDir, {
                  label: `Before ${agentName} · ${tc.function.name}`,
                  conversationId: lineage?.parentConversationId,
                  runId: recorder?.runId,
                  kind: "step",
                  toolCallId: tc.id,
                });
                snapshotId = checkpoint.id;
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                await recorder?.event({
                  kind: "error",
                  label: "Subagent step snapshot unavailable",
                  toolName: tc.function.name,
                  isError: true,
                  detail,
                });
                throw new Error(`Required mutation checkpoint unavailable: ${detail}`);
              }
            }
            await runAgentHooks("beforeToolExecute", {
              agentId: profile.id,
              runId: recorder?.runId,
              conversationId: lineage?.parentConversationId,
              requestId: lineage?.parentRequestId,
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: args,
            });
            await recorder?.toolState({
              toolCallId: tc.id,
              requestId: lineage?.parentRequestId || agentName,
              name: tc.function.name,
              status: "running",
              ...(snapshotId ? { snapshotId } : {}),
            });
          },
          signal,
          childRunId
        );
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          await captureBashMutations();
          await finish("stopped", "");
          signal?.throwIfAborted();
          throw error;
        }
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      await captureBashMutations();
      if (mutationEvidenceFailure) output = `Error: ${mutationEvidenceFailure}${output ? `\nTool output:\n${output}` : ""}`;
      const isError = output.startsWith("Error:");
      const denied = output.startsWith("Error: Tool denied:");
      await recorder?.toolState({
        toolCallId: tc.id,
        requestId: lineage?.parentRequestId || agentName,
        name: tc.function.name,
        status: denied ? "denied" : isError ? "failed" : "completed",
        resultSummary: output.slice(0, 2000),
        ...(isError ? { error: output.slice(0, 2000) } : {}),
        ...(snapshotId ? { snapshotId } : {}),
      });
      await recorder?.event(
        {
          kind: "tool_result",
          label: isError ? "Subagent tool failed" : "Subagent tool completed",
          toolName: tc.function.name,
          isError,
          detail: isError ? output.slice(0, 500) : undefined,
        },
        { toolErrors: (toolMetrics?.toolErrors || 0) + (isError ? 1 : 0) }
      );
      await runAgentHooks("afterToolExecute", {
        agentId: profile.id,
        runId: recorder?.runId,
        conversationId: lineage?.parentConversationId,
        requestId: lineage?.parentRequestId,
        toolCallId: tc.id,
        toolName: tc.function.name,
        input: args,
        output,
        ...(isError ? { error: output } : {}),
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: output.slice(0, 50000),
      });
    }
  }

  // Extract final text
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!completedNaturally) {
    await recorder?.event({
      kind: "error",
      label: "Subagent iteration limit reached",
      isError: true,
      detail: `Maximum iterations: ${profile.budget.maxSteps}`,
    });
  }
  return finish(
    completedNaturally ? "completed" : "failed",
    lastAssistant?.content || "(subagent produced no summary)"
  );
}
