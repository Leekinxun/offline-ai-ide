import path from "node:path";
import type { AgentMode, ToolContext } from "./types.js";
import type { ToolApprovalDecision } from "./toolApproval.js";

export interface AgentNetworkPolicy {
  mode: AgentMode;
  readOnly: boolean;
  primaryAgent: boolean;
  profileAllowsNetwork: boolean;
  networkOrigins?: readonly string[];
}
declare const NETWORK_EXECUTION_GRANT: unique symbol;
export interface NetworkExecutionGrant { readonly [NETWORK_EXECUTION_GRANT]: true; }
const grants = new WeakMap<object, { workspace: string; command: string; toolName: "bash" | "process_start"; revalidate?: () => void }>();

export function isNetworkToolRequest(name: string, input: Record<string, unknown>): boolean {
  return (name === "bash" || name === "process_start") && input.allow_network === true;
}
export function networkPolicyDenial(policy: AgentNetworkPolicy): string | undefined {
  if (policy.mode !== "code" || policy.readOnly || !policy.primaryAgent) return "Network opt-in is available only to the primary Code Agent in a writable workspace";
  if (!policy.profileAllowsNetwork) return "Network opt-in requires the administrator's Code profile isolation.network=true";
  if (!policy.networkOrigins?.includes("*")) return "Network opt-in requires an explicit '*' in the effective admin/workspace sandbox.networkOrigins intersection; individual origins do not permit unrestricted shell networking";
  return undefined;
}
/** Issued by the server permission path after policy and user authorization. */
export function issueNetworkExecutionGrant(policy: AgentNetworkPolicy, decision: ToolApprovalDecision | "full_access", workspace: string, command: string, toolName: "bash" | "process_start", revalidate?: () => void): NetworkExecutionGrant {
  const denied = networkPolicyDenial(policy);
  if (denied) throw new Error(denied);
  if (decision !== "allow_once" && decision !== "full_access") throw new Error("Network access requires a one-time approval or verified full access; session or Plan approval is not sufficient");
  if (decision === "full_access" && !revalidate) throw new Error("Full access network authorization requires a live server verification");
  if (!workspace || !command.trim()) throw new Error("Network approval requires a workspace and exact command");
  revalidate?.();
  const grant = Object.freeze({}) as NetworkExecutionGrant;
  grants.set(grant, { workspace: path.resolve(workspace), command: command.trim(), toolName, ...(revalidate ? { revalidate } : {}) });
  return grant;
}
/** A grant cannot be serialized, rebound to another command, or reused. */
export function consumeNetworkExecutionGrant(grant: NetworkExecutionGrant, workspace: string, command: string, toolName: "bash" | "process_start"): void {
  const binding = grant && typeof grant === "object" ? grants.get(grant) : undefined;
  if (!binding || binding.workspace !== path.resolve(workspace) || binding.command !== command.trim() || binding.toolName !== toolName) throw new Error("Network approval is missing, expired, or does not match this tool, command and workspace");
  // Consume failures permanently invalidate a stale automatic grant. This is
  // synchronous and runs after tool preparation, at the process launch boundary.
  try { binding.revalidate?.(); }
  catch (error) { grants.delete(grant); throw error; }
  grants.delete(grant);
}
export function networkGrantForTool(context: ToolContext, input: Record<string, unknown>): NetworkExecutionGrant | undefined {
  if (input.allow_network === undefined || input.allow_network === false) return undefined;
  if (input.allow_network !== true) throw new Error("allow_network must be a boolean");
  const delegatedLineage = context.lineage && (!context.runId || context.lineage.parentRunId !== context.runId);
  if (context.mode !== "code" || context.agentProfileId !== "code" || (context.subagentDepth || 0) > 0 || delegatedLineage) throw new Error("Network opt-in is unavailable to read-only modes or delegated Agents");
  if (!context.networkExecutionGrant) throw new Error("Network execution requires the server tool approval path");
  return context.networkExecutionGrant;
}
