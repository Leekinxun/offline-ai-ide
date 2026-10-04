import crypto from "crypto";
import path from "node:path";
import { evaluateShellCommand, evaluateWorkspaceWrite } from "./toolPolicy.js";
import { isNetworkToolRequest } from "./networkAccess.js";
import { planReadOnlyShell } from "./readOnlyShell.js";
import { isLocalVerificationCommand } from "./localVerification.js";

export type ToolRisk = "medium" | "high";
export type ToolApprovalDecision = "allow_once" | "allow_session" | "deny";
export type ToolApprovalCause = "user_denied" | "timed_out" | "cancelled" | "invalid_decision";
export interface ToolApprovalOutcome {
  decision: ToolApprovalDecision;
  cause?: ToolApprovalCause;
  timeoutMs?: number;
}

export type ToolApprovalRequirement =
  | { kind: "none" }
  | { kind: "blocked"; reason: string }
  | {
      kind: "approval";
      risk: ToolRisk;
      reason: string;
      scope: string;
      canAllowSession: boolean;
      sessionKey?: string;
    };

const WORKSPACE_SIDE_EFFECT_TOOLS = new Set([
  "memory_write",
  "task_create",
  "task_update",
  "claim_task",
  "send_message",
  "broadcast",
  "shutdown_request",
]);

function workspaceSessionKey(prefix: string, workspaceDir?: string): string {
  const workspaceKey = crypto.createHash("sha256").update(path.resolve(workspaceDir || "unknown-workspace")).digest("hex").slice(0, 16);
  return `${prefix}:${workspaceKey}`;
}

export function classifyToolApproval(
  name: string,
  input: Record<string, unknown>,
  options: { workspaceDir?: string } = {},
): ToolApprovalRequirement {
  if (name === "submit_plan") {
    return {
      kind: "approval",
      risk: "medium",
      reason: "Approve this Plan artifact as the capability contract for the next Code run",
      scope: typeof input.goal === "string" ? input.goal : "Execution plan",
      canAllowSession: false,
    };
  }
  if (name === "rename_file") {
    const source = typeof input.source_path === "string" ? input.source_path : "";
    const target = typeof input.target_path === "string" ? input.target_path : "";
    for (const candidate of [source, target]) {
      const policy = evaluateWorkspaceWrite(candidate);
      if (!policy.allowed) return { kind: "blocked", reason: policy.reason || "Workspace rename blocked" };
    }
    return { kind: "approval", risk: "medium", reason: "Rename an ordinary workspace file without replacing an existing target; session approval covers file changes in this conversation and workspace", scope: `${source} → ${target}`, canAllowSession: true,
      sessionKey: workspaceSessionKey("workspace-files", options.workspaceDir) };
  }
  if (name === "write_file" || name === "edit_file") {
    const target = typeof input.path === "string" ? input.path : "";
    const policy = evaluateWorkspaceWrite(target);
    if (!policy.allowed) {
      return { kind: "blocked", reason: policy.reason || "Workspace write blocked" };
    }
    return {
      kind: "approval",
      risk: "medium",
      reason: name === "write_file" ? "Create or replace an ordinary workspace file; session approval covers file changes in this conversation and workspace" : "Modify an ordinary workspace file; session approval covers file changes in this conversation and workspace",
      scope: target,
      canAllowSession: true,
      sessionKey: workspaceSessionKey("workspace-files", options.workspaceDir),
    };
  }

  if (name === "process_input") {
    const text = input.text === undefined ? "" : input.text;
    if (typeof text !== "string" || Buffer.byteLength(text) > 16_384) return { kind: "blocked", reason: "Process input must be at most 16 KiB of text" };
    if (text.trim()) {
      const policy = evaluateShellCommand(text, { compatibilityShellAuthorized: true, workspaceDir: options.workspaceDir });
      if (!policy.allowed) return { kind: "blocked", reason: policy.reason || "Process input blocked" };
    }
    return { kind: "approval", risk: "high", reason: "Send new interactive input to a process; this can execute additional instructions", scope: `${String(input.session_id || "")}: ${text.slice(0, 400) || "EOF"}`, canAllowSession: false };
  }

  if (name === "bash" || name === "process_start") {
    if (input.allow_network !== undefined && typeof input.allow_network !== "boolean") return { kind: "blocked", reason: "allow_network must be a boolean" };
    const network = isNetworkToolRequest(name, input);
    const command = typeof input.command === "string" ? input.command : "";
    if (name === "bash" && !network && planReadOnlyShell(command)) return { kind: "none" };
    // This is only a preflight. The execution path repeats the policy check
    // after this high-risk approval has been granted.
    const policy = evaluateShellCommand(command, { compatibilityShellAuthorized: true, networkAccessAuthorized: network, workspaceDir: options.workspaceDir });
    if (!policy.allowed) {
      return { kind: "blocked", reason: policy.reason || "Shell command blocked" };
    }
    if (!network && isLocalVerificationCommand(command)) {
      return { kind: "approval", risk: "medium",
        reason: "Run a local test, lint, type check, or build using project code in the workspace; session approval reuses this exact command",
        scope: command, canAllowSession: true, sessionKey: workspaceSessionKey(`${name}:verification:${command.trim()}`, options.workspaceDir) };
    }
    return {
      kind: "approval",
      risk: "high",
      reason: network ? "NETWORK ACCESS: this one command may connect to any network destination and transmit workspace data. Requires both administrator grants and explicit one-time approval or user-enabled full access verified by the server; Plan/ordinary session approval cannot authorize it" : "Execute this command through the compatibility shell in the workspace",
      scope: command,
      canAllowSession: false,
    };
  }

  if (name === "task" || name === "spawn_teammate") {
    return {
      kind: "approval",
      risk: "high",
      reason: "Start an autonomous agent that may perform workspace actions",
      scope: typeof input.prompt === "string" ? input.prompt : name,
      canAllowSession: false,
    };
  }

  if (name.startsWith("mcp_")) {
    return {
      kind: "approval",
      risk: "high",
      reason: "Call an external integration that may use the network and perform provider-defined side effects",
      scope: typeof input.action === "string" ? `${name}:${input.action}` : name,
      canAllowSession: false,
    };
  }

  if (WORKSPACE_SIDE_EFFECT_TOOLS.has(name)) {
    return {
      kind: "approval",
      risk: "medium",
      reason: "Change persistent workspace or collaboration state",
      scope: name,
      canAllowSession: false,
    };
  }

  return { kind: "none" };
}

export interface ToolApprovalRequestInput {
  conversationId?: string;
  requestId: string;
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  risk: ToolRisk;
  reason: string;
  scope: string;
  canAllowSession: boolean;
  sessionKey?: string;
}

export interface ToolApprovalRequestEvent extends ToolApprovalRequestInput {
  approvalId: string;
  createdAt: number;
}

interface PendingApproval {
  request: ToolApprovalRequestEvent;
  networkRequested: boolean;
  conversationId?: string;
  risk: ToolRisk;
  canAllowSession: boolean;
  sessionKey?: string;
  grantGeneration: number;
  resolve: (outcome: ToolApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

export interface ToolApprovalGrants {
  sessionAllowed: Set<string>;
  conversationAllowed: Set<string>;
  generation: number;
}

export function createToolApprovalGrants(): ToolApprovalGrants {
  return { sessionAllowed: new Set(), conversationAllowed: new Set(), generation: 0 };
}

/** Invalidate reusable approvals without resolving any existing pending item. */
export function clearToolApprovalGrants(grants: ToolApprovalGrants): void {
  grants.sessionAllowed.clear(); grants.conversationAllowed.clear(); grants.generation += 1;
}

export class ToolApprovalSession {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly emitRequest: (request: ToolApprovalRequestEvent) => void,
    private readonly timeoutMs = 5 * 60 * 1000,
    private readonly grants: ToolApprovalGrants = createToolApprovalGrants(),
  ) {}

  request(input: ToolApprovalRequestInput): Promise<ToolApprovalDecision> {
    return this.requestDetailed(input).then((outcome) => outcome.decision);
  }

  requestDetailed(input: ToolApprovalRequestInput): Promise<ToolApprovalOutcome> {
    const network = isNetworkToolRequest(input.name, input.input);
    if (network) input = { ...input, risk: "high", canAllowSession: false, sessionKey: undefined };
    if (
      !network && input.name !== "submit_plan" &&
      input.risk !== "high" &&
      input.conversationId &&
      this.grants.conversationAllowed.has(input.conversationId)
    ) {
      return Promise.resolve({ decision: "allow_once" });
    }
    if (!network && input.name !== "submit_plan" && input.risk !== "high" && input.canAllowSession && input.sessionKey && this.grants.sessionAllowed.has(`${input.conversationId || ""}\0${input.sessionKey}`)) {
      return Promise.resolve({ decision: "allow_session" });
    }

    const request = { approvalId: crypto.randomUUID(), createdAt: Date.now(), ...input };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.approvalId);
        resolve({ decision: "deny", cause: "timed_out", timeoutMs: this.timeoutMs });
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(request.approvalId, {
        request,
        networkRequested: network,
        conversationId: input.conversationId,
        risk: input.risk,
        canAllowSession: input.canAllowSession,
        sessionKey: input.sessionKey,
        grantGeneration: this.grants.generation,
        resolve,
        timer,
      });
      this.emitRequest(request);
    });
  }

  listPending(conversationId?: string): ToolApprovalRequestEvent[] {
    return [...this.pending.values()]
      .filter((pending) => !conversationId || pending.conversationId === conversationId)
      .map((pending) => ({ ...pending.request }));
  }

  getPending(approvalId: string): ToolApprovalRequestEvent | null {
    const pending = this.pending.get(approvalId);
    return pending ? { ...pending.request } : null;
  }

  allowConversation(conversationId: string): number {
    const normalized = conversationId.trim();
    if (!normalized) return 0;
    this.grants.conversationAllowed.add(normalized);
    let resolvedCount = 0;
    for (const [approvalId, pending] of this.pending) {
      if (pending.conversationId !== normalized || pending.risk === "high" || pending.request.name === "submit_plan" || pending.networkRequested) continue;
      this.pending.delete(approvalId);
      clearTimeout(pending.timer);
      pending.resolve({ decision: "allow_once" });
      resolvedCount += 1;
    }
    return resolvedCount;
  }

  resolve(approvalId: string, decision: ToolApprovalDecision): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    this.pending.delete(approvalId);
    clearTimeout(pending.timer);

    const acceptedDecision = decision === "allow_session" && pending.networkRequested
      ? "deny" : decision === "allow_session" && (!pending.canAllowSession || pending.risk === "high" || pending.request.name === "submit_plan") ? "allow_once" : decision;
    const effectiveDecision = acceptedDecision === "allow_session" && pending.grantGeneration !== this.grants.generation ? "allow_once" : acceptedDecision;
    if (effectiveDecision === "allow_session" && pending.sessionKey) {
      this.grants.sessionAllowed.add(`${pending.conversationId || ""}\0${pending.sessionKey}`);
    }
    pending.resolve({ decision: effectiveDecision,
      ...(effectiveDecision === "deny" ? { cause: decision === "deny" ? "user_denied" as const : "invalid_decision" as const } : {}) });
    return true;
  }

  pendingCount(conversationId?: string): number {
    if (!conversationId) return this.pending.size;
    return [...this.pending.values()].filter((item) => item.conversationId === conversationId).length;
  }

  clearGrants(): void { clearToolApprovalGrants(this.grants); }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ decision: "deny", cause: "cancelled" });
    }
    this.pending.clear();
  }
}
