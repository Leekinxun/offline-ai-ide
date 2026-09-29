import crypto from "crypto";
import path from "path";
import { evaluateShellCommand, evaluateWorkspaceWrite } from "./toolPolicy.js";
import { isNetworkToolRequest } from "./networkAccess.js";

export type ToolRisk = "medium" | "high";
export type ToolApprovalDecision = "allow_once" | "allow_session" | "deny";

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
    return { kind: "approval", risk: "medium", reason: "Rename a workspace file without replacing an existing target", scope: `${source} → ${target}`, canAllowSession: true,
      sessionKey: `rename_file:${path.posix.dirname(source.replace(/\\/g, "/"))}->${path.posix.dirname(target.replace(/\\/g, "/"))}` };
  }
  if (name === "write_file" || name === "edit_file") {
    const target = typeof input.path === "string" ? input.path : "";
    const policy = evaluateWorkspaceWrite(target);
    if (!policy.allowed) {
      return { kind: "blocked", reason: policy.reason || "Workspace write blocked" };
    }
    const directory = path.posix.dirname(target.replace(/\\/g, "/")) || ".";
    return {
      kind: "approval",
      risk: "medium",
      reason: name === "write_file" ? "Create or replace a workspace file" : "Modify a workspace file",
      scope: target,
      canAllowSession: true,
      sessionKey: `${name}:${directory}`,
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
    // This is only a preflight. The execution path repeats the policy check
    // after this high-risk approval has been granted.
    const policy = evaluateShellCommand(command, { compatibilityShellAuthorized: true, networkAccessAuthorized: network, workspaceDir: options.workspaceDir });
    if (!policy.allowed) {
      return { kind: "blocked", reason: policy.reason || "Shell command blocked" };
    }
    return {
      kind: "approval",
      risk: "high",
      reason: network ? "NETWORK ACCESS: this one command may connect to any network destination and transmit workspace data. Requires both administrator grants and explicit one-time approval; Plan/session approval cannot authorize it" : "Execute this command through the compatibility shell in the workspace",
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
  resolve: (decision: ToolApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export class ToolApprovalSession {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionAllowed = new Set<string>();
  private readonly conversationAllowed = new Set<string>();

  constructor(
    private readonly emitRequest: (request: ToolApprovalRequestEvent) => void,
    private readonly timeoutMs = 5 * 60 * 1000
  ) {}

  request(input: ToolApprovalRequestInput): Promise<ToolApprovalDecision> {
    const network = isNetworkToolRequest(input.name, input.input);
    if (network) input = { ...input, risk: "high", canAllowSession: false, sessionKey: undefined };
    if (
      !network && input.name !== "submit_plan" &&
      input.risk !== "high" &&
      input.conversationId &&
      this.conversationAllowed.has(input.conversationId)
    ) {
      return Promise.resolve("allow_once");
    }
    if (!network && input.sessionKey && this.sessionAllowed.has(input.sessionKey)) {
      return Promise.resolve("allow_session");
    }

    const request = { approvalId: crypto.randomUUID(), createdAt: Date.now(), ...input };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.approvalId);
        resolve("deny");
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(request.approvalId, {
        request,
        networkRequested: network,
        conversationId: input.conversationId,
        risk: input.risk,
        canAllowSession: input.canAllowSession,
        sessionKey: input.sessionKey,
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
    this.conversationAllowed.add(normalized);
    let resolvedCount = 0;
    for (const [approvalId, pending] of this.pending) {
      if (pending.conversationId !== normalized || pending.risk === "high") continue;
      this.pending.delete(approvalId);
      clearTimeout(pending.timer);
      pending.resolve("allow_once");
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
      ? "deny" : decision === "allow_session" && !pending.canAllowSession ? "allow_once" : decision;
    if (acceptedDecision === "allow_session" && pending.sessionKey) {
      this.sessionAllowed.add(pending.sessionKey);
    }
    pending.resolve(acceptedDecision);
    return true;
  }

  pendingCount(conversationId?: string): number {
    if (!conversationId) return this.pending.size;
    return [...this.pending.values()].filter((item) => item.conversationId === conversationId).length;
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve("deny");
    }
    this.pending.clear();
  }
}
