import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../config.js";
import { DEFAULT_TEAMMATE_CAPABILITIES, TeamConfig, TeamMember, OpenAIMessage, OpenAIToolCall, OpenAIToolDef } from "./types.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { safePath } from "../utils/safePath.js";
import { readAuthorizedWorkspaceFile } from "./contextPolicy.js";
import { evaluateWorkspaceWrite } from "./toolPolicy.js";
import {
  createPermissionAuthorizer,
  narrowPermissionAuthorizer,
  type PermissionAuthorizer,
} from "./permissionService.js";
import { runWorkspaceCommand } from "./shell.js";
import { processModelTurn } from "./modelProcessor.js";
import { bindConfiguredFallbacks, buildProviderExecutionContract } from "./providerRouting.js";
import { estimateUsageCostUsd, resolveAgentProfile } from "./agentProfiles.js";
import { runAgentHooks } from "./agentHooks.js";
import { requireModelTurnAction } from "./finishReason.js";
import { createCheckpoint } from "../chat/checkpoints.js";
import { estimateMessageTokens } from "./context.js";
import { createRunId } from "../chat/runHistory.js";
import { AgentRunRecorder, terminalizeInterruptedRun } from "../chat/runHistory.js";
import type { ToolContext } from "./types.js";
import { captureChangeSet } from "../chat/changeSets.js";
import type { ChangeSetStatus } from "../chat/changeSets.js";
import { isProcessAlive } from "../utils/processLiveness.js";
import { createManagedWorktree, listManagedWorktrees, updateManagedWorktreeMetadata, type ManagedWorktree } from "../chat/worktrees.js";
import {
  captureCheckpointMutationsDetailed,
  listMutationEvidenceGaps,
  recordKnownFileMutation,
} from "../files/mutationRegistry.js";
import { OrchestrationStore } from "./orchestrationStore.js";

const TEAMMATE_TOOLS: OpenAIToolDef[] = [
  { type: "function", function: { name: "bash", description: "Run command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_file", description: "Read file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Edit file.", parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } } },
  { type: "function", function: { name: "send_message", description: "Send message.", parameters: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } } },
  { type: "function", function: { name: "idle", description: "Signal no more work.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "claim_task", description: "Claim task by ID.", parameters: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } } },
];

type ManagedChildWorktree = ManagedWorktree & { runId: string };
type ManagedWorktreeFinalization = { id?: string; status: ChangeSetStatus; error?: string };

async function dispatchTeammateTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  agentName: string,
  bus: MessageBus,
  taskMgr: TaskManager,
  authorize: PermissionAuthorizer,
  toolCallId: string,
  onAuthorized?: () => Promise<void>,
  signal?: AbortSignal,
  runId?: string
): Promise<string> {
  const permission = await authorize({
    requestId: `teammate:${agentName}`,
    toolCallId,
    name,
    input: args,
    agentName: `teammate:${agentName}`,
  });
  if (!permission.allowed) return `Error: Tool denied: ${permission.reason || "permission denied"}`;
  await onAuthorized?.();
  switch (name) {
    case "bash": {
      const cmd = args.command as string;
      return runWorkspaceCommand(cmd, cwd, signal, { compatibilityShellAuthorized: true });
    }
    case "read_file":
      try { return readAuthorizedWorkspaceFile(cwd, args.path as string).content.slice(0, 50000); }
      catch (e: any) { return `Error: ${e.message}`; }
    case "write_file":
      {
        const decision = evaluateWorkspaceWrite(args.path as string);
        if (!decision.allowed) return `Error: ${decision.reason || "Write blocked by workspace policy"}`;
      }
      try {
        const full = safePath(args.path as string, cwd);
        const previous = fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : "";
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const content = args.content as string;
        fs.writeFileSync(full, content, "utf-8");
        recordKnownFileMutation({ workspaceDir: cwd, path: args.path as string, source: "assistant_tool", actor: `teammate:${agentName}`, mtimeMs: fs.statSync(full).mtimeMs, content, preimageContent: previous, runId, toolCallId });
        return `Wrote ${(args.content as string).length} bytes`;
      } catch (e: any) { return `Error: ${e.message}`; }
    case "edit_file":
      {
        const decision = evaluateWorkspaceWrite(args.path as string);
        if (!decision.allowed) return `Error: ${decision.reason || "Edit blocked by workspace policy"}`;
      }
      try {
        const full = safePath(args.path as string, cwd);
        const c = fs.readFileSync(full, "utf-8");
        if (!c.includes(args.old_text as string)) return "Error: Text not found";
        const content = c.replace(args.old_text as string, args.new_text as string);
        fs.writeFileSync(full, content, "utf-8");
        recordKnownFileMutation({ workspaceDir: cwd, path: args.path as string, source: "assistant_tool", actor: `teammate:${agentName}`, mtimeMs: fs.statSync(full).mtimeMs, content, preimageContent: c, runId, toolCallId });
        return "Edited";
      } catch (e: any) { return `Error: ${e.message}`; }
    case "send_message":
      return bus.send(agentName, args.to as string, args.content as string);
    case "idle":
      return "Entering idle phase.";
    case "claim_task":
      return taskMgr.claim(args.task_id as number, agentName);
    default:
      return `Unknown tool: ${name}`;
  }
}

export class TeammateManager {
  private teamDir: string;
  private configPath: string;
  private config: TeamConfig;
  private configStore: OrchestrationStore<TeamConfig>;
  private bus: MessageBus;
  private taskMgr: TaskManager;
  private workspaceDir: string;
  private activeLoops: Map<string, { abort: boolean; paused: boolean; steering: string[]; generation: string }> = new Map();

  private managedWorktree(name: string, lineage?: ToolContext["lineage"]): ManagedChildWorktree {
    const ownerId = `teammate:${name}`;
    const owned = listManagedWorktrees(this.workspaceDir).filter((entry) => entry.ownerId === ownerId);
    if (owned.some((entry) => entry.status === "ready_for_review" && entry.reviewState === "pending")) {
      throw new Error(`'${name}' has a ChangeSet awaiting review; apply, reject, or request revision before assigning more work`);
    }
    const revision = owned.find((entry) => entry.status === "needs_revision" && entry.reviewState === "revision_requested");
    if (revision) {
      if (!revision.runId) throw new Error(`'${name}' managed revision is missing child run metadata`);
      return revision as ManagedChildWorktree;
    }
    if (owned.some((entry) => entry.status === "running" && entry.reviewState === "pending")) {
      throw new Error(`'${name}' already has an active managed worktree`);
    }
    const created = createManagedWorktree(this.workspaceDir, { name: `teammate-${name}`, ownerId, childRunId: createRunId(), parentRunId: lineage?.parentRunId, toolCallId: lineage?.parentToolCallId });
    if (!created.runId) throw new Error(`'${name}' managed worktree is missing child run metadata`);
    return created as ManagedChildWorktree;
  }

  private finalizeManagedWorktree(name: string, reason: string): ManagedWorktreeFinalization | undefined {
    const member = this.findMember(name);
    const worktree = listManagedWorktrees(this.workspaceDir).find((entry) => entry.ownerId === `teammate:${name}` && (
      (entry.status === "running" && entry.reviewState === "pending") ||
      (entry.status === "needs_revision" && entry.reviewState === "revision_requested")
    ));
    if (!worktree) return undefined;
    try {
      const mutationEvidenceGaps = worktree.runId
        ? listMutationEvidenceGaps(worktree.path, { runId: worktree.runId })
        : [];
      const changeSet = captureChangeSet(this.workspaceDir, worktree.id, {
        agentName: `teammate:${name}`,
        memberName: name,
        parentTaskId: member?.parentTaskId,
        childRunId: worktree.runId,
        reason,
        mutationEvidenceGaps,
      });
      this.bus.send(name, "lead", changeSet.status === "no_changes"
        ? `ChangeSet ${changeSet.id} (no_changes) completed without workspace changes.`
        : changeSet.status === "needs_attention"
          ? `ChangeSet ${changeSet.id} (needs_attention) has incomplete mutation evidence; request revision or reject before integration.`
          : `ChangeSet ${changeSet.id} (${changeSet.status}) is ready for review.`);
      return { id: changeSet.id, status: changeSet.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateManagedWorktreeMetadata(this.workspaceDir, worktree.id, "needs_attention", "pending");
      this.bus.send(name, "lead", `ChangeSet capture failed (needs_attention): ${message}`);
      return { status: "needs_attention", error: message };
    }
  }

  constructor(workspaceDir: string, bus: MessageBus, taskMgr: TaskManager) {
    this.workspaceDir = workspaceDir;
    this.teamDir = path.join(workspaceDir, ".team");
    this.configPath = path.join(this.teamDir, "config.json");
    this.bus = bus;
    this.taskMgr = taskMgr;
    try {
      fs.mkdirSync(this.teamDir, { recursive: true });
    } catch { /* defer */ }
    this.configStore = new OrchestrationStore(workspaceDir, "team-config", () => this.loadLegacyConfig());
    this.config = this.configStore.snapshot();
    this.reconcile();
  }

  private loadLegacyConfig(): TeamConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        return { ...JSON.parse(fs.readFileSync(this.configPath, "utf-8")), schemaVersion: 1 };
      }
    } catch { /* default */ }
    return { schemaVersion: 1, team_name: "default", members: [], version: 1 };
  }

  private saveConfig(): void {
    try {
      fs.mkdirSync(this.teamDir, { recursive: true });
      // Merge member revisions inside the cross-process store. This preserves
      // independently-added members and provides a monotonic conflict fence.
      const local = structuredClone(this.config);
      this.config = this.configStore.transact((persisted) => {
        const byName = new Map(persisted.members.map((member) => [member.name, member]));
        for (const candidate of local.members) {
          const current = byName.get(candidate.name);
          if (!current) persisted.members.push(structuredClone(candidate));
          else if ((candidate.version || 0) > (current.version || 0)) Object.assign(current, structuredClone(candidate));
          else if ((candidate.version || 0) === (current.version || 0) && JSON.stringify(candidate) !== JSON.stringify(current)) { candidate.version = (candidate.version || 0) + 1; Object.assign(current, structuredClone(candidate)); }
        }
        if ((local.version || 0) >= (persisted.version || 0)) { persisted.team_name = local.team_name; persisted.budget = local.budget ? { ...local.budget } : persisted.budget; persisted.workspaceBudget = local.workspaceBudget ? { ...local.workspaceBudget } : persisted.workspaceBudget; persisted.version = Math.max(local.version || 0, persisted.version || 0); }
        return structuredClone(persisted);
      });
      const temporary = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.config, null, 2));
      fs.renameSync(temporary, this.configPath);
    } catch { /* ignore */ }
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private setStatus(name: string, status: TeamMember["status"], currentTask?: string, expectedExecutionId?: string): void {
    this.config = this.configStore.transact((state) => { const member = state.members.find((candidate) => candidate.name === name); if (!member || expectedExecutionId && member.executionId !== expectedExecutionId) return structuredClone(state); member.status = status; member.updatedAt = Date.now(); if (currentTask !== undefined) member.currentTask = currentTask; if (status === "shutdown") member.currentTask = undefined; member.heartbeatAt = Date.now(); member.version = (member.version || 0) + 1; return structuredClone(state); });
    this.saveConfig();
  }

  async spawn(
    name: string,
    role: string,
    prompt: string,
    authorizeTool?: PermissionAuthorizer,
    signal?: AbortSignal,
    lineage?: ToolContext["lineage"]
  ): Promise<string> {
    if (this.activeLoops.has(name)) return `Error: '${name}' already has an active execution`;
    this.config = this.configStore.snapshot();
    const existingMember = this.findMember(name);
    const effectiveLineage = lineage || (existingMember?.parentRunId && existingMember.parentConversationId && existingMember.parentRequestId && existingMember.parentToolCallId ? {
      parentRunId: existingMember.parentRunId,
      parentTaskId: existingMember.parentTaskId,
      parentConversationId: existingMember.parentConversationId,
      parentRequestId: existingMember.parentRequestId,
      parentToolCallId: existingMember.parentToolCallId,
    } : undefined);
    this.reconcile();
    if (existingMember?.status === "working" || existingMember?.status === "paused") return `Error: '${name}' is currently working`;
    const budget = this.config.budget;
    const active = this.config.members.filter((candidate) => candidate.status === "working" || candidate.status === "paused").length;
    if (budget?.maxConcurrentAgents && active >= budget.maxConcurrentAgents) return `Error: team concurrency budget exceeded (${budget.maxConcurrentAgents})`;
    if (this.config.workspaceBudget?.maxConcurrentAgents && active >= this.config.workspaceBudget.maxConcurrentAgents) return `Error: workspace concurrency budget exceeded (${this.config.workspaceBudget.maxConcurrentAgents})`;
    let childWorkspace: ManagedChildWorktree;
    try {
      childWorkspace = this.managedWorktree(name, effectiveLineage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("awaiting review") || message.includes("active managed worktree")) return `Error: ${message}`;
      return `Error: isolated worktree allocation failed; refusing to spawn '${name}': ${message}`;
    }
    const generation = crypto.randomUUID();
    let member = existingMember;
    if (member) {
      member.status = "working";
      member.role = role;
      member.currentTask = prompt.slice(0, 180);
      member.startedAt = Date.now();
      member.updatedAt = Date.now();
      member.id ||= `teammate:${name}`;
      member.parentAgentId = "lead";
      member.parentRunId = effectiveLineage?.parentRunId;
      member.parentTaskId = effectiveLineage?.parentTaskId;
      member.parentConversationId = effectiveLineage?.parentConversationId;
      member.parentRequestId = effectiveLineage?.parentRequestId;
      member.parentToolCallId = effectiveLineage?.parentToolCallId;
      member.childRunId = childWorkspace.runId;
      member.worktreePath = childWorkspace.path;
      member.worktreeId = childWorkspace.id;
      member.model = config.modelName;
      member.permissions = ["scoped_worktree"];
      member.capabilities = [...DEFAULT_TEAMMATE_CAPABILITIES];
      member.budget = { maxTokens: config.agentMaxTokens, maxDurationMs: resolveAgentProfile("teammate", config.agentProfiles).budget.maxDurationMs, maxCostUsd: resolveAgentProfile("teammate", config.agentProfiles).budget.maxCostUsd, ...member.budget, usedTokens: 0, usedCostUsd: 0, startedAt: Date.now() };
      member.evidence = [];
      member.leaseExpiresAt = Date.now() + 45_000;
      member.executionId = generation;
      member.processId = process.pid;
    } else {
      member = {
        name,
        role,
        status: "working",
        currentTask: prompt.slice(0, 180),
        startedAt: Date.now(),
        updatedAt: Date.now(),
        id: `teammate:${name}`,
        parentAgentId: "lead",
        ...(effectiveLineage?.parentRunId ? { parentRunId: effectiveLineage.parentRunId } : {}),
        ...(effectiveLineage?.parentTaskId ? { parentTaskId: effectiveLineage.parentTaskId } : {}),
        ...(effectiveLineage?.parentConversationId ? { parentConversationId: effectiveLineage.parentConversationId } : {}),
        ...(effectiveLineage?.parentRequestId ? { parentRequestId: effectiveLineage.parentRequestId } : {}),
        ...(effectiveLineage?.parentToolCallId ? { parentToolCallId: effectiveLineage.parentToolCallId } : {}),
        childRunId: childWorkspace.runId,
        worktreePath: childWorkspace.path,
        worktreeId: childWorkspace.id,
        model: config.modelName,
        permissions: ["scoped_worktree"],
        capabilities: [...DEFAULT_TEAMMATE_CAPABILITIES],
        budget: { maxTokens: config.agentMaxTokens, usedTokens: 0, usedCostUsd: 0, startedAt: Date.now() },
        evidence: [],
        version: 1,
        heartbeatAt: Date.now(),
        leaseExpiresAt: Date.now() + 45_000,
        executionId: generation,
        processId: process.pid,
      };
      this.config.members.push(member as TeamMember);
    }
    this.saveConfig();

    // Start background loop (non-blocking)
    const control = { abort: false, paused: false, steering: [], generation };
    this.activeLoops.set(name, control);
    const profile = resolveAgentProfile("teammate", config.agentProfiles, {
      modelName: config.modelName,
      maxOutputTokens: config.agentMaxTokens,
    });
    const authorize = authorizeTool
      ? narrowPermissionAuthorizer(authorizeTool, profile)
      : createPermissionAuthorizer({ mode: "code", readOnly: false, signal, profile });
    const recorder = effectiveLineage ? new AgentRunRecorder(this.workspaceDir, childWorkspace.runId, effectiveLineage.parentConversationId, "code", undefined, {
      parentRunId: effectiveLineage.parentRunId,
      parentTaskId: effectiveLineage.parentTaskId,
      parentToolCallId: effectiveLineage.parentToolCallId,
      parentRequestId: effectiveLineage.parentRequestId,
      agentName: `teammate:${name}`,
    }) : undefined;
    await recorder?.start();
    this.runTeammateLoop(name, role, prompt, control, authorize, childWorkspace.path, childWorkspace.runId, signal).catch(() => {
      this.finalizeManagedWorktree(name, "failure");
      this.setStatus(name, "failed", "Execution failed", control.generation);
    }).finally(async () => {
      if (!recorder) return;
      const memberStatus = this.listDetails().find((candidate) => candidate.name === name)?.status;
      const runStatus = memberStatus === "idle" ? "completed" : memberStatus === "failed" ? "failed" : "stopped";
      await recorder.finish(runStatus);
    });

    return `Spawned '${name}' (role: ${role})`;
  }

  private async runTeammateLoop(
    name: string,
    role: string,
    prompt: string,
    control: { abort: boolean; paused: boolean; steering: string[]; generation: string },
    authorize: PermissionAuthorizer,
    childWorkspaceDir: string,
    childRunId: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.setStatus(name, "working", prompt ? prompt.slice(0, 180) : "Continuing assigned work", control.generation);
    const sysPrompt = `You are '${name}', role: ${role}, team: ${this.config.team_name}, at ${childWorkspaceDir}. This is your isolated managed worktree; never access the parent workspace. Use idle when done with current work.`;
    const messages: OpenAIMessage[] = [{ role: "user", content: prompt }];
    const vllmUrl = config.vllmApiUrl;
    const vllmApiKey = config.vllmApiKey;
    const profile = resolveAgentProfile("teammate", config.agentProfiles, {
      modelName: config.modelName,
      maxOutputTokens: config.agentMaxTokens,
    });
    const model = profile.modelName || config.modelName;
    const managedScope = listManagedWorktrees(this.workspaceDir).find((entry) => path.resolve(entry.path) === path.resolve(childWorkspaceDir));
    const startedAt = Date.now();
    let toolCalls = 0;
    let estimatedCostUsd = 0;

    // Work phase
    for (
      let round = 0;
      round < profile.budget.maxSteps &&
      Date.now() - startedAt < profile.budget.maxDurationMs &&
      (profile.budget.maxCostUsd <= 0 || estimatedCostUsd < profile.budget.maxCostUsd) &&
      !control.abort &&
      !signal?.aborted;
      round++
    ) {
      this.heartbeat(name, control.generation);
      if (!this.consumeUsage(name, control.generation, 0, 0)) { control.abort = true; this.setStatus(name, "failed", "Budget exhausted", control.generation); break; }
      if (control.paused) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
      // Check inbox
      const inbox = this.bus.leaseInbox(name, `${name}:${control.generation}`, 50, 300_000);
      const handledIds = this.handledMessageIds(name);
      const pendingInbox: typeof inbox = [];
      for (const { message: msg, token } of inbox) {
        if (msg.id && handledIds.has(msg.id)) { this.bus.ack(name, msg.id, token); continue; }
        if (msg.type === "shutdown_request") {
          this.setStatus(name, "shutdown", undefined, control.generation);
          if (msg.id && this.commitHandledMessages(name, control.generation, [msg.id])) this.bus.ack(name, msg.id, token);
          this.finalizeManagedWorktree(name, "shutdown");
          this.activeLoops.delete(name);
          return;
        }
        messages.push({ role: "user", content: JSON.stringify(msg) });
        pendingInbox.push({ message: msg, token });
      }
      for (const steering of control.steering.splice(0)) messages.push({ role: "user", content: `STEERING: ${steering}` });

      let data;
      try {
        const executionContract = buildProviderExecutionContract({
          id: `${profile.id}:isolated-teammate`,
          permissions: profile.permissions.allow,
          isolation: `managed_worktree:${managedScope?.id || control.generation}`,
          tools: TEAMMATE_TOOLS.map((tool) => tool.function.name),
        });
        const processed = await processModelTurn({
          apiUrl: vllmUrl,
          apiKey: vllmApiKey,
          model,
          providerId: profile.providerId,
          systemPrompt: sysPrompt,
          messages,
          tools: TEAMMATE_TOOLS,
          executionContract,
          fallbacks: bindConfiguredFallbacks(config.modelFallbacks, executionContract, profile.budget.maxOutputTokens),
          fallbackMaxOutputTokens: profile.budget.maxOutputTokens,
          maxOutputTokens: profile.budget.maxOutputTokens,
          hookContext: { agentId: `teammate:${name}` },
          signal,
          contextAudit: {
            storeWorkspaceDir: this.workspaceDir,
            effectiveWorkspaceDir: childWorkspaceDir,
            scope: {
              kind: "managed_worktree",
              scopeId: managedScope?.id || control.generation,
              worktreeId: managedScope?.id,
              baseSha: managedScope?.baseSha,
              headSha: managedScope?.head,
            },
            purpose: "teammate",
            runId: childRunId,
            requestId: control.generation,
            agentId: `teammate:${name}`,
          },
        });
        data = processed.response;
      } catch {
        this.finalizeManagedWorktree(name, "failure");
        this.setStatus(name, "shutdown", undefined, control.generation);
        this.activeLoops.delete(name);
        return;
      }

      const choice = data.choices?.[0];
      if (!choice) { this.finalizeManagedWorktree(name, "failure"); this.setStatus(name, "shutdown", undefined, control.generation); this.activeLoops.delete(name); return; }
      const usage = data.usage || {};
      const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : estimateMessageTokens(messages);
      const completionTokens = typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : estimateMessageTokens([{ role: "assistant", content: choice.message.content, tool_calls: choice.message.tool_calls }]);
      const turnCostUsd = estimateUsageCostUsd(
        profile,
        promptTokens,
        completionTokens
      );
      estimatedCostUsd += turnCostUsd;
      if (!this.consumeUsage(name, control.generation, promptTokens + completionTokens, turnCostUsd)) {
        control.abort = true;
        this.setStatus(name, "failed", "Budget exhausted", control.generation);
        break;
      }

      let turnAction: ReturnType<typeof requireModelTurnAction>;
      try {
        turnAction = requireModelTurnAction(choice);
      } catch {
        this.finalizeManagedWorktree(name, "failure");
        this.setStatus(name, "shutdown", undefined, control.generation);
        this.activeLoops.delete(name);
        return;
      }

      const pendingIds = pendingInbox.map(({ message }) => message.id).filter((id): id is string => Boolean(id));
      const commitPendingInbox = (): boolean => {
        if (!pendingIds.length) return true;
        if (!this.commitHandledMessages(name, control.generation, pendingIds)) return false;
        for (const { message, token } of pendingInbox) if (message.id) this.bus.ack(name, message.id, token);
        return true;
      };

      messages.push({ role: "assistant", content: choice.message.content, tool_calls: choice.message.tool_calls });

      if (turnAction === "stop") { if (!commitPendingInbox()) return; break; }

      let idleRequested = false;
      for (const tc of choice.message.tool_calls as OpenAIToolCall[]) {
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        if (tc.function.name === "idle") idleRequested = true;
        let output: string;
        let snapshotId: string | undefined;
        let mutationEvidenceFailure = "";
        if (toolCalls >= profile.budget.maxToolCalls) {
          output = `Error: Agent tool-call budget exceeded (${profile.budget.maxToolCalls})`;
        } else {
          toolCalls += 1;
          try {
            output = await dispatchTeammateTool(
              tc.function.name,
              args,
              childWorkspaceDir,
              name,
              this.bus,
              this.taskMgr,
              authorize,
              tc.id,
              async () => {
                if (["bash", "write_file", "edit_file"].includes(tc.function.name)) {
                  try {
                    const checkpoint = createCheckpoint(childWorkspaceDir, {
                      label: `Before teammate:${name} · ${tc.function.name}`,
                      kind: "step",
                      toolCallId: tc.id,
                    });
                    snapshotId = checkpoint.id;
                  } catch (error) {
                    throw new Error(
                      `Required mutation checkpoint unavailable: ${error instanceof Error ? error.message : String(error)}`,
                      { cause: error }
                    );
                  }
                }
                await runAgentHooks("beforeToolExecute", {
                  agentId: `teammate:${name}`,
                  toolCallId: tc.id,
                  toolName: tc.function.name,
                  input: args,
                });
              },
              signal,
              childRunId
            );
          } catch (error) {
            output = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          if (tc.function.name === "bash" && snapshotId) {
            try {
              const captured = captureCheckpointMutationsDetailed(childWorkspaceDir, {
                checkpointId: snapshotId,
                runId: childRunId,
                toolCallId: tc.id,
                actor: `teammate:${name}`,
              });
              if (captured.skipped.length) {
                mutationEvidenceFailure = `Mutation evidence incomplete: ${captured.skipped
                  .map((entry) => `${entry.path}:${entry.reason}`)
                  .join(", ")}`;
              }
            } catch (error) {
              mutationEvidenceFailure = `Mutation evidence capture failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          if (mutationEvidenceFailure) output = `Error: ${mutationEvidenceFailure}${output ? `\nTool output:\n${output}` : ""}`;
          await runAgentHooks("afterToolExecute", {
            agentId: `teammate:${name}`,
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: args,
            output,
            ...(output.startsWith("Error:") ? { error: output } : {}),
          });
        }
        console.log(`  [${name}] ${tc.function.name}: ${output.slice(0, 120)}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }

      // The command receipt is committed only after every requested tool call
      // and its mutation/hook recording finished. A thrown tool phase leaves the
      // lease unacked so restart can replay the command at least once.
      if (!commitPendingInbox()) return;
      if (idleRequested) break;
    }

    // A captured ChangeSet is immutable. Stop this loop at the review gate;
    // request_revision must explicitly restart the teammate on the same worktree.
    if (this.activeLoops.get(name) !== control) return;
    const gatedMember = this.findMember(name);
    if (gatedMember?.requiresPlanApproval && !gatedMember.planApproved || gatedMember?.minimumCompletionQuality !== undefined && (gatedMember.completionQuality === undefined || gatedMember.completionQuality < gatedMember.minimumCompletionQuality) || (gatedMember?.requiresPlanApproval || gatedMember?.minimumCompletionQuality !== undefined) && !gatedMember.evidence?.length) {
      this.setStatus(name, "failed", "Completion gate unmet", control.generation); this.activeLoops.delete(name); return;
    }
    const changeSet = this.finalizeManagedWorktree(name, control.abort ? "stopped" : "idle");
    if (control.abort) { this.activeLoops.delete(name); return; }
    this.setStatus(name, changeSet?.status === "needs_attention" ? "failed" : changeSet ? "idle" : "shutdown", changeSet
      ? changeSet.status === "no_changes"
        ? `ChangeSet ${changeSet.id} (no_changes)`
        : changeSet.status === "needs_attention"
          ? changeSet.id ? `ChangeSet ${changeSet.id} needs attention` : `ChangeSet capture needs attention: ${changeSet.error || "capture failed"}`
        : `ChangeSet ${changeSet.id} ready for review`
      : undefined, control.generation);
    this.activeLoops.delete(name);
  }

  listAll(): string {
    if (this.config.members.length === 0) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  listDetails(): TeamMember[] {
    return this.config.members.map((member) => ({
      ...member,
      budget: member.budget ? { ...member.budget } : undefined,
      permissions: member.permissions ? [...member.permissions] : undefined,
      capabilities: [...new Set([...(member.capabilities || []), ...DEFAULT_TEAMMATE_CAPABILITIES])],
      evidence: member.evidence ? [...member.evidence] : undefined,
      steering: member.steering ? [...member.steering] : undefined,
      handledMessageIds: member.handledMessageIds ? [...member.handledMessageIds] : undefined,
    }));
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }

  /** Restart safety: no process-local loop means working members are interrupted, never silently working. */
  reconcile(now = Date.now()): number {
    this.config = this.configStore.snapshot();
    let changed = 0;
    for (const member of this.config.members) {
      if ((member.status === "working" || member.status === "paused") && !this.activeLoops.has(member.name)) {
        const liveProcess = member.processId ? isProcessAlive(member.processId) : false;
        if (liveProcess && member.leaseExpiresAt && member.leaseExpiresAt > now) continue;
        member.status = member.heartbeatAt && now - member.heartbeatAt > 60_000 ? "orphaned" : "interrupted";
        member.updatedAt = now; member.version = (member.version || 0) + 1; changed++;
      }
    }
    if (changed) this.saveConfig();
    return changed;
  }

  heartbeat(name: string, expectedExecutionId?: string): boolean { let found = false; this.config = this.configStore.transact((state) => { const member = state.members.find((candidate) => candidate.name === name); if (!member || expectedExecutionId && member.executionId !== expectedExecutionId || expectedExecutionId && member.status !== "working" && member.status !== "paused") return structuredClone(state); found = true; member.heartbeatAt = Date.now(); member.leaseExpiresAt = Date.now() + 45_000; member.updatedAt = Date.now(); member.version = (member.version || 0) + 1; return structuredClone(state); }); this.saveConfig(); return found; }
  stop(name: string): boolean { const control = this.activeLoops.get(name); const member = this.findMember(name); if (!member) return false; if (control) control.abort = true; else { this.finalizeManagedWorktree(name, "stopped-after-restart"); if (member.childRunId) terminalizeInterruptedRun(this.workspaceDir, member.childRunId, "stopped"); } this.setStatus(name, "stopped"); return true; }
  steer(name: string, content: string): boolean { const control = this.activeLoops.get(name); const member = this.findMember(name); if (!member || !content.trim()) return false; if (control) control.steering.push(content.slice(0, 8000)); member.steering = [...(member.steering || []), content.slice(0, 8000)].slice(-20); this.saveConfig(); return true; }
  pause(name: string): boolean { const control = this.activeLoops.get(name); if (!control || !this.findMember(name)) return false; control.paused = true; this.setStatus(name, "paused"); return true; }
  resume(name: string): boolean { const control = this.activeLoops.get(name); if (!control || !this.findMember(name)) return false; control.paused = false; this.setStatus(name, "working"); return true; }
  retry(name: string, authorizeTool?: PermissionAuthorizer, signal?: AbortSignal): Promise<string> { const member = this.findMember(name); if (!member) return Promise.resolve(`Error: '${name}' not found`); return this.spawn(name, member.role, member.currentTask || "Continue previous task", authorizeTool, signal); }
  reassign(name: string, prompt: string): boolean { const member = this.findMember(name); if (!member) return false; member.currentTask = prompt.slice(0, 180); return this.steer(name, prompt); }
  async replace(name: string, role: string, prompt: string, authorizeTool?: PermissionAuthorizer, signal?: AbortSignal): Promise<string> { const active = this.activeLoops.get(name); if (active) { active.abort = true; for (let attempt = 0; attempt < 100 && this.activeLoops.get(name) === active; attempt++) await new Promise((resolve) => setTimeout(resolve, 10)); if (this.activeLoops.get(name) === active) return `Error: '${name}' previous execution did not stop`; } return this.spawn(name, role, prompt, authorizeTool, signal); }
  /** Optimistic-concurrency budget update for transport clients. Runtime usage is
   * server-owned, so callers may only change limits, never used accounting. */
  updateBudget(name: string, budgetPatch: Partial<Pick<NonNullable<TeamMember["budget"]>, "maxConcurrentAgents" | "maxTokens" | "maxCostUsd" | "maxDurationMs">>, expectedVersion: number): TeamMember {
    const allowed = ["maxConcurrentAgents", "maxTokens", "maxCostUsd", "maxDurationMs"] as const;
    let updated!: TeamMember;
    this.config = this.configStore.transact((state) => { const member = state.members.find((candidate) => candidate.name === name); if (!member) throw new Error(`'${name}' not found`); if (!Number.isSafeInteger(expectedVersion) || member.version !== expectedVersion) throw new Error("Agent version conflict"); const next = { ...(member.budget || {}) }; for (const key of allowed) { const value = budgetPatch[key]; if (value === undefined) continue; if (!Number.isFinite(value) || value < 0 || (key !== "maxCostUsd" && !Number.isSafeInteger(value))) throw new Error(`Invalid budget ${key}`); const ceiling = key === "maxCostUsd" ? 1_000_000 : 10_000_000_000; if (value > ceiling) throw new Error(`Budget ${key} exceeds maximum`); next[key] = value; } member.budget = next; member.capabilities = [...new Set([...(member.capabilities || []), ...DEFAULT_TEAMMATE_CAPABILITIES])]; member.updatedAt = Date.now(); member.version = (member.version || 0) + 1; updated = structuredClone(member); return structuredClone(state); });
    this.saveConfig();
    return updated;
  }

  approvePlan(name: string, expectedVersion: number): TeamMember {
    let updated!: TeamMember; this.config = this.configStore.transact((state) => { const member = state.members.find((candidate) => candidate.name === name); if (!member) throw new Error(`'${name}' not found`); if (member.version !== expectedVersion) throw new Error("Agent version conflict"); member.planApproved = true; member.version = (member.version || 0) + 1; member.updatedAt = Date.now(); updated = structuredClone(member); return structuredClone(state); }); this.saveConfig(); return updated;
  }

  recordCompletionEvidence(name: string, evidence: string[], quality: number, expectedVersion: number): TeamMember {
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error("Completion quality must be between 0 and 1");
    const clean = evidence.filter((item) => typeof item === "string" && item.trim()).map((item) => item.slice(0, 2000)).slice(0, 50); if (!clean.length) throw new Error("Completion evidence is required");
    let updated!: TeamMember; this.config = this.configStore.transact((state) => { const member = state.members.find((candidate) => candidate.name === name); if (!member) throw new Error(`'${name}' not found`); if (member.version !== expectedVersion) throw new Error("Agent version conflict"); member.evidence = clean; member.completionQuality = quality; member.version = (member.version || 0) + 1; member.updatedAt = Date.now(); updated = structuredClone(member); return structuredClone(state); }); this.saveConfig(); return updated;
  }

  private consumeUsage(name: string, executionId: string, tokens: number, costUsd: number): boolean {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isFinite(costUsd) || costUsd < 0) return false;
    let accepted = false;
    this.config = this.configStore.transact((state) => {
      const member = state.members.find((candidate) => candidate.name === name);
      if (!member || member.executionId !== executionId || (member.status !== "working" && member.status !== "paused")) return structuredClone(state);
      const now = Date.now();
      const budgets = [member.budget, state.budget, state.workspaceBudget].filter((item): item is NonNullable<typeof item> => Boolean(item));
      const exceeds = budgets.some((budget) => (budget.maxTokens !== undefined && (budget.usedTokens || 0) + tokens > budget.maxTokens) || (budget.maxCostUsd !== undefined && (budget.usedCostUsd || 0) + costUsd > budget.maxCostUsd) || (budget.maxDurationMs !== undefined && now - (budget.startedAt || member.startedAt || now) > budget.maxDurationMs));
      if (exceeds) { member.status = "failed"; member.currentTask = "Budget exhausted"; member.version = (member.version || 0) + 1; return structuredClone(state); }
      for (const budget of budgets) { budget.usedTokens = (budget.usedTokens || 0) + tokens; budget.usedCostUsd = (budget.usedCostUsd || 0) + costUsd; budget.startedAt ||= member.startedAt || now; }
      member.version = (member.version || 0) + 1; member.updatedAt = now; accepted = true; return structuredClone(state);
    });
    this.saveConfig();
    return accepted;
  }

  private handledMessageIds(name: string): Set<string> {
    const member = this.configStore.snapshot().members.find((candidate) => candidate.name === name);
    return new Set(member?.handledMessageIds || []);
  }

  /** Commits model/control handling before the message lease is acknowledged.
   * A crash after this commit but before ACK is safe: replay observes the receipt
   * and acknowledges without injecting the command into another model turn. */
  private commitHandledMessages(name: string, executionId: string, messageIds: string[]): boolean {
    if (!messageIds.length) return true;
    let committed = false;
    this.config = this.configStore.transact((state) => {
      const member = state.members.find((candidate) => candidate.name === name);
      if (!member || member.executionId !== executionId) return structuredClone(state);
      member.handledMessageIds = [...new Set([...(member.handledMessageIds || []), ...messageIds])].slice(-2000);
      member.version = (member.version || 0) + 1; member.updatedAt = Date.now(); committed = true;
      return structuredClone(state);
    });
    this.saveConfig();
    return committed;
  }
}
