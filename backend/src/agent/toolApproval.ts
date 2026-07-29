import crypto from "crypto";
import path from "path";
import { evaluateShellCommand, evaluateWorkspaceWrite } from "./toolPolicy.js";

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
  input: Record<string, unknown>
): ToolApprovalRequirement {
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

  if (name === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const policy = evaluateShellCommand(command);
    if (!policy.allowed) {
      return { kind: "blocked", reason: policy.reason || "Shell command blocked" };
    }
    return {
      kind: "approval",
      risk: "high",
      reason: "Execute a shell command in the workspace",
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
      reason: "Call an external integration with provider-defined side effects",
      scope: name,
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
}

interface PendingApproval {
  conversationId?: string;
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
    if (input.conversationId && this.conversationAllowed.has(input.conversationId)) {
      return Promise.resolve("allow_once");
    }
    if (input.sessionKey && this.sessionAllowed.has(input.sessionKey)) {
      return Promise.resolve("allow_session");
    }

    const approvalId = crypto.randomUUID();
    this.emitRequest({ approvalId, ...input });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        resolve("deny");
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(approvalId, {
        conversationId: input.conversationId,
        canAllowSession: input.canAllowSession,
        sessionKey: input.sessionKey,
        resolve,
        timer,
      });
    });
  }

  allowConversation(conversationId: string): number {
    const normalized = conversationId.trim();
    if (!normalized) return 0;
    this.conversationAllowed.add(normalized);
    let resolvedCount = 0;
    for (const [approvalId, pending] of this.pending) {
      if (pending.conversationId !== normalized) continue;
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

    const acceptedDecision =
      decision === "allow_session" && !pending.canAllowSession ? "allow_once" : decision;
    if (acceptedDecision === "allow_session" && pending.sessionKey) {
      this.sessionAllowed.add(pending.sessionKey);
    }
    pending.resolve(acceptedDecision);
    return true;
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve("deny");
    }
    this.pending.clear();
  }
}
