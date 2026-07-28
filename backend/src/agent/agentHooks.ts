export type AgentHookName =
  | "beforeModelRequest"
  | "afterModelResponse"
  | "beforePermissionCheck"
  | "afterPermissionDecision"
  | "beforeToolExecute"
  | "afterToolExecute"
  | "beforeCompaction"
  | "afterCompaction";

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
}

export type AgentHookHandler = (context: AgentHookContext) => Promise<void> | void;

export interface AgentHookRegistration {
  name: string;
  critical?: boolean;
  handlers: Partial<Record<AgentHookName, AgentHookHandler>>;
}

const registrations: AgentHookRegistration[] = [];

export function registerAgentHooks(registration: AgentHookRegistration): () => void {
  if (!registration.name.trim()) throw new Error("Agent hook registration requires a name");
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
  };
}

export async function runAgentHooks(
  hook: AgentHookName,
  context: AgentHookContext
): Promise<Array<{ name: string; error: string }>> {
  const failures: Array<{ name: string; error: string }> = [];
  for (const registration of registrations) {
    const handler = registration.handlers[hook];
    if (!handler) continue;
    try {
      await handler({ ...context, metadata: context.metadata ? { ...context.metadata } : undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name: registration.name, error: message });
      if (registration.critical) {
        throw new Error(`Critical agent hook '${registration.name}' failed during ${hook}: ${message}`);
      }
    }
  }
  return failures;
}

export function clearAgentHooksForTests(): void {
  registrations.splice(0, registrations.length);
}
