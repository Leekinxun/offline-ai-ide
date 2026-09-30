import type { AgentMode } from "./types.js";
import {
  classifyToolApproval,
  type ToolApprovalDecision,
  type ToolApprovalOutcome,
  type ToolApprovalRequestInput,
} from "./toolApproval.js";
import { agentProfileAllowsTool, type AgentProfile } from "./agentProfiles.js";
import { runAgentHooks } from "./agentHooks.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";
import { evaluateModeCapability } from "./modeCapabilities.js";
import { PolicyAuditLog, type PolicyAuditSink } from "./policyAudit.js";
import { redactSecrets } from "./secretRedaction.js";
import path from "node:path";
import { isNetworkToolRequest, issueNetworkExecutionGrant, networkPolicyDenial, type AgentNetworkPolicy, type NetworkExecutionGrant } from "./networkAccess.js";

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
  networkExecutionGrant?: NetworkExecutionGrant;
}

export type PermissionAuthorizer = (
  request: PermissionRequest
) => Promise<PermissionResult>;

export function narrowPermissionAuthorizer(
  parent: PermissionAuthorizer,
  profile: AgentProfile
): PermissionAuthorizer {
  return async (request) => {
    if (isNetworkToolRequest(request.name, request.input)) return { allowed: false, reason: "Delegated Agents cannot request unrestricted network access" };
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
  requestApproval?: (input: ToolApprovalRequestInput) => Promise<ToolApprovalDecision | ToolApprovalOutcome>;
  profile?: AgentProfile;
  runId?: string;
  /** When both workspace and runId are supplied, decisions are durably audited. */
  workspace?: string;
  auditLog?: PolicyAuditSink;
  executionPlan?: ExecutionPlan;
  /** Re-read after the approval prompt so a revoked grant cannot start a command. */
  networkPolicy?: (toolName: string) => { profileAllowsNetwork: boolean; networkOrigins?: readonly string[]; readOnly?: boolean };
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
    const networkRequested = isNetworkToolRequest(request.name, request.input);
    const requestedNetworkTool = request.name as "bash" | "process_start";
    const requestedNetworkCommand = typeof request.input.command === "string" ? request.input.command.trim() : "";
    const currentNetworkPolicy = (): AgentNetworkPolicy => {
      const current = options.networkPolicy?.(request.name) || { profileAllowsNetwork: options.profile?.isolation.network === true, networkOrigins: [] };
      return { ...current, mode: options.mode, readOnly: options.readOnly || current.readOnly === true, primaryAgent: request.agentName === "primary" && options.profile?.id === "code" };
    };
    if (networkRequested) {
      try {
        const denied = networkPolicyDenial(currentNetworkPolicy());
        if (denied || !options.workspace) return decide({ allowed: false, reason: denied || "Network approval has no workspace binding" });
      } catch { return decide({ allowed: false, reason: "Network policy could not be verified" }); }
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
    const requirement = classifyToolApproval(request.name, request.input, { workspaceDir: options.workspace });

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
      options.executionPlan && !networkRequested &&
      (request.name === "write_file" || request.name === "edit_file" || request.name === "rename_file" || request.name === "bash" || request.name === "process_start")
    ) {
      return decide({ allowed: true, decision: "not_required" });
    }
    if (!options.requestApproval) {
      return decide({
        allowed: false,
        reason: `No interactive approval channel is available for ${request.agentName}`,
      });
    }

    const approvalOutcome = await options.requestApproval({
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
    const decision = typeof approvalOutcome === "string" ? approvalOutcome : approvalOutcome.decision;
    if (options.signal?.aborted) {
      return decide({ allowed: false, reason: "The agent run was stopped", decision: "deny" });
    }
    if (decision === "deny") {
      const cause = typeof approvalOutcome === "string" ? "user_denied" : approvalOutcome.cause || "user_denied";
      const reason = cause === "timed_out"
        ? `Tool approval timed out${typeof approvalOutcome !== "string" && approvalOutcome.timeoutMs ? ` after ${approvalOutcome.timeoutMs / 1000} seconds` : ""}; no approval was received and the tool was not executed`
        : cause === "cancelled" ? "Tool approval was cancelled; the tool was not executed"
          : cause === "invalid_decision" ? "This tool requires an explicit one-time approval; session approval was not accepted"
            : "The user denied this tool execution";
      return decide({ allowed: false, reason, decision });
    }
    if (networkRequested) {
      if (decision !== "allow_once") return decide({ allowed: false, reason: "Network access requires an explicit allow_once decision; session approval is not accepted", decision });
      try {
        const networkExecutionGrant = issueNetworkExecutionGrant(currentNetworkPolicy(), decision, options.workspace!, requestedNetworkCommand, requestedNetworkTool);
        return decide({ allowed: true, decision, networkExecutionGrant });
      } catch (error) { return decide({ allowed: false, decision: "deny", reason: error instanceof Error ? error.message : "Network policy could not be verified" }); }
    }
    return decide({ allowed: true, decision });
  };
}
