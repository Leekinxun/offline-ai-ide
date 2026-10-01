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
const grants = new WeakMap<object, { workspace: string; command: string; toolName: "bash" | "process_start" }>();

export function isNetworkToolRequest(name: string, input: Record<string, unknown>): boolean {
  return (name === "bash" || name === "process_start") && input.allow_network === true;
}
export function networkPolicyDenial(policy: AgentNetworkPolicy): string | undefined {
  if (policy.mode !== "code" || policy.readOnly || !policy.primaryAgent) return "Network opt-in is available only to the primary Code Agent in a writable workspace";
  if (!policy.profileAllowsNetwork) return "Network opt-in requires the administrator's Code profile isolation.network=true";
  if (!policy.networkOrigins?.includes("*")) return "Network opt-in requires an explicit '*' in the effective admin/workspace sandbox.networkOrigins intersection; individual origins do not permit unrestricted shell networking";
  return undefined;
}
/** Issued only after policy checks and a fresh, explicit allow_once decision. */
export function issueNetworkExecutionGrant(policy: AgentNetworkPolicy, decision: ToolApprovalDecision, workspace: string, command: string, toolName: "bash" | "process_start"): NetworkExecutionGrant {
  const denied = networkPolicyDenial(policy);
  if (denied) throw new Error(denied);
  if (decision !== "allow_once") throw new Error("Network access requires a one-time approval; session or Plan approval is not sufficient");
  if (!workspace || !command.trim()) throw new Error("Network approval requires a workspace and exact command");
  const grant = Object.freeze({}) as NetworkExecutionGrant;
  grants.set(grant, { workspace: path.resolve(workspace), command: command.trim(), toolName });
  return grant;
}
/** A grant cannot be serialized, rebound to another command, or reused. */
export function consumeNetworkExecutionGrant(grant: NetworkExecutionGrant, workspace: string, command: string, toolName: "bash" | "process_start"): void {
  const binding = grant && typeof grant === "object" ? grants.get(grant) : undefined;
  if (!binding || binding.workspace !== path.resolve(workspace) || binding.command !== command.trim() || binding.toolName !== toolName) throw new Error("Network approval is missing, expired, or does not match this tool, command and workspace");
  grants.delete(grant);
}
export function networkGrantForTool(context: ToolContext, input: Record<string, unknown>): NetworkExecutionGrant | undefined {
  if (input.allow_network === undefined || input.allow_network === false) return undefined;
  if (input.allow_network !== true) throw new Error("allow_network must be a boolean");
  if (context.mode !== "code" || context.agentProfileId !== "code" || (context.subagentDepth || 0) > 0 || context.lineage) throw new Error("Network opt-in is unavailable to read-only modes or delegated Agents");
  if (!context.networkExecutionGrant) throw new Error("Network execution requires the explicit one-time tool approval path");
  return context.networkExecutionGrant;
}
