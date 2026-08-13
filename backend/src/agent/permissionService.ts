import type { AgentMode } from "./types.js";
import {
  classifyToolApproval,
  type ToolApprovalDecision,
  type ToolApprovalRequestInput,
} from "./toolApproval.js";
import { agentProfileAllowsTool, type AgentProfile } from "./agentProfiles.js";
import { runAgentHooks } from "./agentHooks.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";
import { evaluateModeCapability } from "./modeCapabilities.js";
import { PolicyAuditLog, type PolicyAuditSink } from "./policyAudit.js";
import { redactSecrets } from "./secretRedaction.js";
import path from "node:path";

export interface PermissionRequest {
  requestId: string;
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  agentName: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  decision?: ToolApprovalDecision | "not_required";
  requiresReplan?: boolean;
}

export type PermissionAuthorizer = (
  request: PermissionRequest
) => Promise<PermissionResult>;

export function narrowPermissionAuthorizer(
  parent: PermissionAuthorizer,
  profile: AgentProfile
): PermissionAuthorizer {
  return async (request) => {
    if (!agentProfileAllowsTool(profile, request.name)) {
      return {
        allowed: false,
        reason: `Agent profile '${profile.id}' does not allow ${request.name}`,
      };
    }
    return parent(request);
  };
}

export function createPermissionAuthorizer(options: {
  mode: AgentMode;
  readOnly: boolean;
  signal?: AbortSignal;
  requestApproval?: (input: ToolApprovalRequestInput) => Promise<ToolApprovalDecision>;
  profile?: AgentProfile;
  runId?: string;
  /** When both workspace and runId are supplied, decisions are durably audited. */
  workspace?: string;
  auditLog?: PolicyAuditSink;
  executionPlan?: ExecutionPlan;
}): PermissionAuthorizer {
  const audit = options.auditLog ?? (options.workspace && options.runId
    ? new PolicyAuditLog(path.join(options.workspace, ".crewforge", "policy-audit.jsonl"))
    : undefined);
  return async (request) => {
    const safeInput = redactSecrets(request.input);
    await runAgentHooks("beforePermissionCheck", {
      agentId: request.agentName,
      runId: options.runId,
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      toolName: request.name,
      input: safeInput,
    });
    const decide = async (result: PermissionResult): Promise<PermissionResult> => {
      if (audit && options.workspace && options.runId) {
        audit.append({
          runId: options.runId,
          workspace: options.workspace,
          requestId: request.requestId,
          toolCallId: request.toolCallId,
          toolName: request.name,
          allowed: result.allowed,
          ...(result.reason ? { reason: result.reason } : {}),
          input: safeInput,
        });
      }
      await runAgentHooks("afterPermissionDecision", {
        agentId: request.agentName,
        runId: options.runId,
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        toolName: request.name,
        input: safeInput,
        metadata: {
          allowed: result.allowed,
          reason: result.reason,
          decision: result.decision,
          requiresReplan: result.requiresReplan,
        },
      });
      return result;
    };
    if (options.signal?.aborted) {
      return decide({ allowed: false, reason: "The agent run was stopped" });
    }
    if (options.profile && !agentProfileAllowsTool(options.profile, request.name)) {
      return decide({
        allowed: false,
        reason: `Agent profile '${options.profile.id}' does not allow ${request.name}`,
      });
    }
    const capability = evaluateModeCapability({
      mode: options.mode,
      toolName: request.name,
      input: request.input,
      executionPlan: options.executionPlan,
    });
    if (!capability.allowed) {
      return decide({
        allowed: false,
        reason: capability.reason,
        requiresReplan: capability.requiresReplan,
      });
    }
    const requirement = classifyToolApproval(request.name, request.input);

    if (request.name.startsWith("mcp_") && options.readOnly) {
      return decide({
        allowed: false,
        reason: "MCP tools are unavailable in read-only workspaces",
      });
    }
    if (options.readOnly && requirement.kind !== "none") {
      return decide({ allowed: false, reason: "The active workspace role is read-only" });
    }
    if (requirement.kind === "blocked") {
      return decide({ allowed: false, reason: requirement.reason });
    }
    if (requirement.kind === "none") {
      return decide({ allowed: true, decision: "not_required" });
    }
    if (
      options.executionPlan &&
      (request.name === "write_file" || request.name === "edit_file" || request.name === "bash")
    ) {
      return decide({ allowed: true, decision: "not_required" });
    }
    if (!options.requestApproval) {
      return decide({
        allowed: false,
        reason: `No interactive approval channel is available for ${request.agentName}`,
      });
    }

    const decision = await options.requestApproval({
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      name: request.name,
      input: request.input,
      risk: requirement.risk,
      reason: `${requirement.reason} · requested by ${request.agentName}`,
      scope: requirement.scope,
      canAllowSession: requirement.canAllowSession,
      sessionKey: requirement.sessionKey,
    });
    if (options.signal?.aborted) {
      return decide({ allowed: false, reason: "The agent run was stopped", decision: "deny" });
    }
    return decide(decision === "deny"
      ? { allowed: false, reason: "Tool execution was denied or cancelled", decision }
      : { allowed: true, decision });
  };
}
