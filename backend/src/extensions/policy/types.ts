export type ExtensionPermission = string;

export interface PermissionLayer {
  id: string;
  allow: string[];
  deny?: string[];
  signed?: boolean;
}

export interface SandboxGrant {
  readPaths?: string[];
  writePaths?: string[];
  networkOrigins?: string[];
  secretEnv?: string[];
}

export interface AdminPolicyBundle {
  schemaVersion: 1;
  version: number;
  permissions: PermissionLayer;
  sandbox: SandboxGrant;
  trustedSigningKeys?: Record<string, string>;
  updatedAt: string;
}

export interface WorkspacePolicyOverride {
  schemaVersion: 1;
  version: number;
  adminPolicyVersion: number;
  permissions: PermissionLayer;
  sandbox: SandboxGrant;
  updatedAt: string;
}

export interface PermissionExplanation {
  permission: string;
  allowed: boolean;
  layers: Array<{ id: string; allowed: boolean; reason: string }>;
  effectiveSandbox: SandboxGrant;
}

export type ExtensionHookEvent =
  | "session.start" | "session.end"
  | "run.start" | "run.complete" | "run.error"
  | "model.request.before" | "model.response.after"
  | "permission.check.before" | "permission.decision.after"
  | "tool.execute.before" | "tool.execute.after"
  | "agent.start" | "agent.stop"
  | "task.create" | "task.update" | "task.complete"
  | "compaction.before" | "compaction.after"
  | "validation.before" | "validation.after"
  | "checkpoint.before" | "checkpoint.after"
  | "worktree.create.before" | "worktree.create.after" | "worktree.remove.before" | "worktree.remove.after"
  | "delivery.prepare" | "delivery.approve" | "delivery.publish" | "delivery.reconcile"
  | "completion.quality";

export interface CommandHookTransport {
  kind: "command";
  command: string;
  args: Array<string | number | boolean>;
  cwd?: string;
}

export interface HttpHookTransport {
  kind: "http";
  url: string;
  method: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
}

export interface McpHookTransport {
  kind: "mcp";
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type ExtensionHookTransport = CommandHookTransport | HttpHookTransport | McpHookTransport;

export interface ExtensionHookDeclaration {
  id: string;
  event: ExtensionHookEvent;
  permissions: string[];
  transport: ExtensionHookTransport;
  sandbox: SandboxGrant;
  failureMode: "open" | "closed";
  timeoutMs: number;
  maxRetries: number;
  maxOutputBytes: number;
  blocksCompletion?: boolean;
}

export interface HookExecutionContext {
  workspaceDir: string;
  runId?: string;
  requestId?: string;
  actorId: string;
  payload: Record<string, unknown>;
}

export interface HookExecutionResult {
  hookId: string;
  event: ExtensionHookEvent;
  ok: boolean;
  attempts: number;
  durationMs: number;
  blocked: boolean;
  output?: unknown;
  error?: string;
}
