import { TraceStore } from "../chat/traceStore.js";
import { executeExtensionHook, type HookTransportAdapters } from "../extensions/policy/evaluator.js";
import type { ExtensionHookDeclaration, ExtensionHookEvent, PermissionLayer, SandboxGrant } from "../extensions/policy/types.js";

export type AgentHookName =
  | "sessionStart"
  | "sessionEnd"
  | "runStart"
  | "runComplete"
  | "runError"
  | "beforeModelRequest"
  | "afterModelResponse"
  | "beforePermissionCheck"
  | "afterPermissionDecision"
  | "beforeToolExecute"
  | "afterToolExecute"
  | "agentStart"
  | "agentStop"
  | "taskCreate"
  | "taskUpdate"
  | "taskComplete"
  | "beforeCompaction"
  | "afterCompaction"
  | "beforeValidation"
  | "afterValidation"
  | "beforeCheckpoint"
  | "afterCheckpoint"
  | "beforeWorktreeCreate"
  | "afterWorktreeCreate"
  | "beforeWorktreeRemove"
  | "afterWorktreeRemove"
  | "deliveryPrepare"
  | "deliveryApprove"
  | "deliveryPublish"
  | "deliveryReconcile"
  | "repositoryQuality";

export interface AgentHookContext {
  agentId: string;
  runId?: string;
  conversationId?: string;
  requestId?: string;
  toolCallId?: string;
  toolName?: string;
  providerId?: string;
  modelName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  /** Optional workspace makes hook activity durable without changing existing callers. */
  workspaceDir?: string;
}

export interface AgentHookOutcome {
  ok?: boolean;
  blockCompletion?: boolean;
  reason?: string;
  output?: unknown;
}

export type AgentHookHandler = (context: AgentHookContext) => Promise<void | AgentHookOutcome> | void | AgentHookOutcome;

export interface AgentHookRegistration {
  name: string;
  critical?: boolean;
  failureMode?: "open" | "closed";
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputBytes?: number;
  handlers: Partial<Record<AgentHookName, AgentHookHandler>>;
}

const registrations: AgentHookRegistration[] = [];
let hookGeneration = 0;

const DECLARATIVE_EVENT_MAP: Record<ExtensionHookEvent, AgentHookName> = {
  "session.start": "sessionStart", "session.end": "sessionEnd",
  "run.start": "runStart", "run.complete": "runComplete", "run.error": "runError",
  "model.request.before": "beforeModelRequest", "model.response.after": "afterModelResponse",
  "permission.check.before": "beforePermissionCheck", "permission.decision.after": "afterPermissionDecision",
  "tool.execute.before": "beforeToolExecute", "tool.execute.after": "afterToolExecute",
  "agent.start": "agentStart", "agent.stop": "agentStop",
  "task.create": "taskCreate", "task.update": "taskUpdate", "task.complete": "taskComplete",
  "compaction.before": "beforeCompaction", "compaction.after": "afterCompaction",
  "validation.before": "beforeValidation", "validation.after": "afterValidation",
  "checkpoint.before": "beforeCheckpoint", "checkpoint.after": "afterCheckpoint",
  "worktree.create.before": "beforeWorktreeCreate", "worktree.create.after": "afterWorktreeCreate",
  "worktree.remove.before": "beforeWorktreeRemove", "worktree.remove.after": "afterWorktreeRemove",
  "delivery.prepare": "deliveryPrepare", "delivery.approve": "deliveryApprove", "delivery.publish": "deliveryPublish", "delivery.reconcile": "deliveryReconcile",
  "completion.quality": "repositoryQuality",
};

export function registerDeclarativeAgentHook(
  declaration: ExtensionHookDeclaration,
  policy: {
    permissionLayers?: PermissionLayer[];
    sandboxLayers?: SandboxGrant[];
    adapters?: HookTransportAdapters;
    resolve?: (context: AgentHookContext) => { permissionLayers: PermissionLayer[]; sandboxLayers: SandboxGrant[]; adapters?: HookTransportAdapters };
  }
): () => void {
  const hook = DECLARATIVE_EVENT_MAP[declaration.event];
  return registerAgentHooks({
    name: declaration.id,
    failureMode: declaration.failureMode,
    critical: declaration.blocksCompletion === true,
    timeoutMs: declaration.timeoutMs + 50,
    handlers: {
      [hook]: async (context: AgentHookContext) => {
        const workspaceDir = context.workspaceDir || (typeof context.metadata?.workspaceDir === "string" ? context.metadata.workspaceDir : "");
        if (!workspaceDir) throw new Error("Declarative hooks require workspaceDir");
        const effective = policy.resolve?.(context) || { permissionLayers: policy.permissionLayers || [], sandboxLayers: policy.sandboxLayers || [], adapters: policy.adapters };
        const result = await executeExtensionHook(declaration, {
          workspaceDir, actorId: context.agentId, runId: context.runId, requestId: context.requestId,
          payload: { input: context.input, output: context.output, error: context.error, metadata: context.metadata },
        }, effective.permissionLayers, effective.sandboxLayers, effective.adapters);
        return { ok: result.ok, blockCompletion: result.blocked, reason: result.error, output: result };
      },
    },
  });
}

export function registerAgentHooks(registration: AgentHookRegistration): () => void {
  if (!registration.name.trim()) throw new Error("Agent hook registration requires a name");
  registrations.push(registration);
  hookGeneration += 1;
  return () => {
    const index = registrations.indexOf(registration);
    if (index >= 0) { registrations.splice(index, 1); hookGeneration += 1; }
  };
}

export function hasAgentHooks(hook: AgentHookName): boolean { return registrations.some((registration) => Boolean(registration.handlers[hook])); }
export function getAgentHooksGeneration(): number { return hookGeneration; }

export async function runAgentHooks(
  hook: AgentHookName,
  context: AgentHookContext
): Promise<Array<{ name: string; error: string }>> {
  const failures: Array<{ name: string; error: string }> = [];
  appendHookTrace(hook, context);
  for (const registration of registrations) {
    const handler = registration.handlers[hook];
    if (!handler) continue;
    try {
      const timeoutMs = normalizeBounded(registration.timeoutMs, 10_000, 1, 120_000);
      const maxRetries = normalizeBounded(registration.maxRetries, 0, 0, 3);
      const maxOutputBytes = normalizeBounded(registration.maxOutputBytes, 64 * 1024, 1, 1024 * 1024);
      let attempt = 0;
      let outcome: void | AgentHookOutcome;
      for (;;) {
        attempt += 1;
        try {
          outcome = await withTimeout(
            Promise.resolve(handler({ ...context, metadata: context.metadata ? { ...context.metadata } : undefined })),
            timeoutMs
          );
          break;
        } catch (error) {
          if (attempt > maxRetries || !isRetryable(error)) throw error;
        }
      }
      if (outcome !== undefined && Buffer.byteLength(JSON.stringify(outcome)) > maxOutputBytes) {
        throw new Error("Agent hook output limit exceeded");
      }
      if (outcome?.ok === false || (hook === "repositoryQuality" && outcome?.blockCompletion)) {
        throw new Error(outcome.reason || "Repository quality policy rejected completion");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name: registration.name, error: message });
      if (registration.critical || registration.failureMode === "closed") {
        throw new Error(`Critical agent hook '${registration.name}' failed during ${hook}: ${message}`);
      }
    }
  }
  return failures;
}

export async function assertRepositoryQuality(
  context: AgentHookContext
): Promise<Array<{ name: string; error: string }>> {
  return runAgentHooks("repositoryQuality", context);
}

function normalizeBounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Agent hook timed out"), { retryable: true })), timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function isRetryable(error: unknown): boolean {
  return Boolean((error as { retryable?: boolean })?.retryable || (error as { transient?: boolean })?.transient);
}

function appendHookTrace(hook: AgentHookName, context: AgentHookContext): void {
  const workspace = context.workspaceDir || (typeof context.metadata?.workspaceDir === "string" ? context.metadata.workspaceDir : undefined);
  if (!workspace) return;
  try {
    const kind = hook.includes("Permission") ? "approval" : hook.includes("Tool") ? "tool" : hook.includes("Compaction") || hook.includes("Checkpoint") ? "checkpoint" : "agent";
    new TraceStore(workspace).append({
      kind,
      action: hook,
      correlationId: context.runId || context.conversationId || context.agentId,
      causationId: context.requestId || context.toolCallId,
      runId: context.runId,
      conversationId: context.conversationId,
      agentId: context.agentId,
      requestId: context.requestId,
      toolCallId: context.toolCallId,
      evidence: context.error,
      metadata: { toolName: context.toolName, providerId: context.providerId, modelName: context.modelName, ...context.metadata },
    });
  } catch { /* hooks remain non-disruptive */ }
}

export function clearAgentHooksForTests(): void {
  registrations.splice(0, registrations.length);
  hookGeneration += 1;
}
