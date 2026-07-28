import type { AgentMode } from "./types.js";
import {
  classifyToolApproval,
  type ToolApprovalDecision,
  type ToolApprovalRequestInput,
} from "./toolApproval.js";
import { agentProfileAllowsTool, type AgentProfile } from "./agentProfiles.js";
import { runAgentHooks } from "./agentHooks.js";

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
}): PermissionAuthorizer {
  return async (request) => {
    await runAgentHooks("beforePermissionCheck", {
      agentId: request.agentName,
      runId: options.runId,
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      toolName: request.name,
      input: request.input,
    });
    const decide = async (result: PermissionResult): Promise<PermissionResult> => {
      await runAgentHooks("afterPermissionDecision", {
        agentId: request.agentName,
        runId: options.runId,
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        toolName: request.name,
        input: request.input,
        metadata: { allowed: result.allowed, reason: result.reason, decision: result.decision },
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
    const requirement = classifyToolApproval(request.name, request.input);

    if (request.name.startsWith("mcp_") && (options.readOnly || options.mode !== "code")) {
      return decide({
        allowed: false,
        reason: `MCP tools are unavailable in ${options.readOnly ? "read-only workspaces" : `${options.mode} mode`}`,
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
