import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../../agent/secretRedaction.js";
import { compileFilesystemPolicy, runWorkspaceProcess } from "../../agent/processSandbox.js";
import type { CompiledFilesystemPolicy } from "../../agent/processSandbox.js";
import { TraceStore } from "../../chat/traceStore.js";
import type {
  ExtensionHookDeclaration,
  HookExecutionContext,
  HookExecutionResult,
  PermissionExplanation,
  PermissionLayer,
  SandboxGrant,
} from "./types.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function layerAllowsPermission(layer: PermissionLayer, permission: string): boolean {
  if (layer.signed === false) return false;
  if ((layer.deny || []).some((pattern) => matches(pattern, permission))) return false;
  return layer.allow.some((pattern) => matches(pattern, permission));
}

export function intersectPermissionLayers(layers: PermissionLayer[], candidates?: string[]): string[] {
  const universe = candidates || Array.from(new Set(layers.flatMap((layer) => layer.allow.filter((item) => item !== "*"))));
  return universe.filter((permission) => layers.every((layer) => layerAllowsPermission(layer, permission))).sort();
}

export function intersectSandboxGrants(grants: SandboxGrant[]): SandboxGrant {
  const intersect = (key: keyof SandboxGrant): string[] => {
    if (grants.length === 0) return [];
    const first = grants[0][key] || [];
    return first.filter((value) => grants.every((grant) => (grant[key] || []).includes(value)));
  };
  return {
    readPaths: intersect("readPaths"),
    writePaths: intersect("writePaths"),
    networkOrigins: intersect("networkOrigins"),
    secretEnv: intersect("secretEnv"),
  };
}

export function explainPermission(
  permission: string,
  layers: PermissionLayer[],
  sandboxLayers: SandboxGrant[] = []
): PermissionExplanation {
  const decisions = layers.map((layer) => {
    const denied = (layer.deny || []).some((pattern) => matches(pattern, permission));
    const allowed = !denied && layer.signed !== false && layer.allow.some((pattern) => matches(pattern, permission));
    return {
      id: layer.id,
      allowed,
      reason: layer.signed === false ? "layer signature is not verified" : denied ? "explicitly denied" : allowed ? "explicitly allowed" : "not granted",
    };
  });
  return { permission, allowed: decisions.every((item) => item.allowed), layers: decisions, effectiveSandbox: intersectSandboxGrants(sandboxLayers) };
}

function canonicalPath(workspaceDir: string, candidate: string): string {
  const root = fs.realpathSync.native(path.resolve(workspaceDir));
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Path escapes workspace");
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Symlink paths are not permitted");
  }
  return resolved;
}

export function validateHookDeclaration(declaration: ExtensionHookDeclaration, effectiveSandbox?: SandboxGrant): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(declaration.id)) throw new Error("Invalid hook id");
  if (!declaration.permissions.length || declaration.permissions.some((item) => !item.trim())) throw new Error("Hook permissions must be explicit");
  if (!Number.isInteger(declaration.timeoutMs) || declaration.timeoutMs < 1 || declaration.timeoutMs > 120_000) throw new Error("Invalid hook timeout");
  if (!Number.isInteger(declaration.maxRetries) || declaration.maxRetries < 0 || declaration.maxRetries > 3) throw new Error("Invalid hook retry limit");
  if (!Number.isInteger(declaration.maxOutputBytes) || declaration.maxOutputBytes < 1 || declaration.maxOutputBytes > 1_048_576) throw new Error("Invalid hook output limit");
  for (const name of declaration.sandbox.secretEnv || []) if (!ENV_NAME.test(name)) throw new Error("Invalid secret environment grant");
  if (declaration.transport.kind === "command") {
    if (!declaration.transport.command.trim() || !Array.isArray(declaration.transport.args)) throw new Error("Command hooks require structured argv");
    if (!declaration.permissions.includes("hook.command.execute")) throw new Error("Command hook lacks hook.command.execute permission");
  } else if (declaration.transport.kind === "http") {
    const url = new URL(declaration.transport.url);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("HTTP hook must use HTTPS or loopback");
    if (url.username || url.password) throw new Error("HTTP hook URL cannot contain credentials");
    if (!declaration.permissions.includes("hook.http.request")) throw new Error("HTTP hook lacks hook.http.request permission");
    const allowedOrigins = effectiveSandbox?.networkOrigins || declaration.sandbox.networkOrigins || [];
    if (!allowedOrigins.includes(url.origin)) throw new Error("HTTP hook origin is not explicitly granted");
    for (const [name, value] of Object.entries(declaration.transport.headers || {})) {
      const secret = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
      if (/authorization|cookie|api[-_]key|token/i.test(name) && !secret) throw new Error("Sensitive HTTP headers must reference an explicitly granted secret environment variable");
      if (secret && !(effectiveSandbox?.secretEnv || declaration.sandbox.secretEnv || []).includes(secret)) throw new Error(`HTTP hook secret environment variable is not granted: ${secret}`);
    }
  } else {
    if (!declaration.transport.serverId.trim() || !declaration.transport.toolName.trim() || !declaration.transport.arguments || Array.isArray(declaration.transport.arguments)) throw new Error("MCP hooks require exact server, tool, and structured arguments");
    if (!declaration.permissions.includes("hook.mcp.call")) throw new Error("MCP hook lacks hook.mcp.call permission");
  }
}

export interface HookTransportAdapters {
  command?: (input: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; sandbox: SandboxGrant; effectiveFilesystemPolicy: CompiledFilesystemPolicy }) => Promise<unknown>;
  http?: (input: { url: string; method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<unknown>;
  mcp?: (input: { serverId: string; toolName: string; arguments: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown>;
  audit?: (record: Record<string, unknown>) => void;
  trace?: (record: Record<string, unknown>) => void;
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Hook output limit exceeded");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error("Hook output limit exceeded"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function recordHookResult(context: HookExecutionContext, result: HookExecutionResult, adapters: HookTransportAdapters): void {
  const safe = redactSecrets({ ...result, actorId: context.actorId, runId: context.runId, requestId: context.requestId });
  const auditPath = path.join(context.workspaceDir, ".codex", "audit", "extension-hooks.jsonl");
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(auditPath) && fs.lstatSync(auditPath).isSymbolicLink()) throw new Error("Audit path cannot be a symlink");
    fs.appendFileSync(auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...safe })}\n`, { mode: 0o600 });
  } catch { /* an audit sink cannot weaken the policy decision */ }
  try {
    new TraceStore(context.workspaceDir).append({ kind: "agent", action: `extension_hook:${result.event}`, correlationId: context.runId || context.actorId, causationId: context.requestId, runId: context.runId, requestId: context.requestId, agentId: context.actorId, evidence: result.error, metadata: { hookId: result.hookId, ok: result.ok, attempts: result.attempts, blocked: result.blocked } });
  } catch { /* trace is supplemental to the append-only audit */ }
  adapters.audit?.(safe as Record<string, unknown>);
  adapters.trace?.(safe as Record<string, unknown>);
}

async function invoke(
  declaration: ExtensionHookDeclaration,
  context: HookExecutionContext,
  signal: AbortSignal,
  adapters: HookTransportAdapters,
  sandbox: SandboxGrant
): Promise<unknown> {
  const transport = declaration.transport;
  if (transport.kind === "command") {
    const cwd = canonicalPath(context.workspaceDir, transport.cwd || ".");
    const env: NodeJS.ProcessEnv = {};
    for (const name of sandbox.secretEnv || []) if (process.env[name] !== undefined) env[name] = process.env[name];
    const effectiveFilesystemPolicy = compileFilesystemPolicy(context.workspaceDir, sandbox);
    const input = { command: transport.command, args: transport.args.map(String), cwd, env, signal, sandbox: structuredClone(sandbox), effectiveFilesystemPolicy };
    if (adapters.command) return adapters.command(input);
    const output = await runWorkspaceProcess({ executable: input.command, args: input.args, cwd: input.cwd, env: input.env as Record<string, string>, signal, timeoutMs: declaration.timeoutMs, maxOutputBytes: declaration.maxOutputBytes, networkMode: "deny", filesystem: { workspaceDir: context.workspaceDir, readPaths: sandbox.readPaths || [], writePaths: sandbox.writePaths || [] } });
    if (output.startsWith("Error:")) throw new Error(output.slice("Error:".length).trim());
    return output;
  }
  if (transport.kind === "http") {
    const body = JSON.stringify(redactSecrets(context.payload));
    const headers = Object.fromEntries(Object.entries(transport.headers || {}).map(([name, value]) => {
      const secret = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
      return [name, secret ? (process.env[secret] || "") : value];
    }));
    if (adapters.http) return adapters.http({ url: transport.url, method: transport.method, headers: { "content-type": "application/json", ...headers }, body, signal });
    const response = await fetch(transport.url, { method: transport.method, headers: { "content-type": "application/json", ...headers }, body, signal, redirect: "error" });
    if (!response.ok) throw Object.assign(new Error(`HTTP hook failed with ${response.status}`), { transient: response.status >= 500 });
    return readLimitedResponse(response, declaration.maxOutputBytes);
  }
  if (!adapters.mcp) throw new Error("MCP adapter is required");
  return adapters.mcp({ serverId: transport.serverId, toolName: transport.toolName, arguments: { ...transport.arguments, context: redactSecrets(context.payload) }, signal });
}

export async function executeExtensionHook(
  declaration: ExtensionHookDeclaration,
  context: HookExecutionContext,
  permissionLayers: PermissionLayer[],
  sandboxLayers: SandboxGrant[],
  adapters: HookTransportAdapters = {}
): Promise<HookExecutionResult> {
  const started = Date.now();
  const sandbox = intersectSandboxGrants(sandboxLayers);
  validateHookDeclaration(declaration, sandbox);
  for (const permission of declaration.permissions) {
    const explanation = explainPermission(permission, permissionLayers, sandboxLayers);
    if (!explanation.allowed) throw new Error(`Permission denied: ${permission}`);
  }
  let attempts = 0;
  let lastError = "Hook failed";
  while (attempts <= declaration.maxRetries) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Hook timed out")), declaration.timeoutMs);
    try {
      const output = await Promise.race([
        invoke(declaration, context, controller.signal, adapters, sandbox),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("Hook timed out"), { transient: true })), { once: true })),
      ]);
      const bytes = Buffer.byteLength(typeof output === "string" ? output : JSON.stringify(output ?? null));
      if (bytes > declaration.maxOutputBytes) throw new Error("Hook output limit exceeded");
      const result: HookExecutionResult = { hookId: declaration.id, event: declaration.event, ok: true, attempts, durationMs: Date.now() - started, blocked: false, output: redactSecrets(output) };
      recordHookResult(context, result, adapters);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const transient = controller.signal.aborted || Boolean((error as { transient?: boolean })?.transient);
      if (!transient || attempts > declaration.maxRetries) break;
    } finally { clearTimeout(timer); }
  }
  const blocked = declaration.failureMode === "closed" || declaration.blocksCompletion === true;
  const result: HookExecutionResult = { hookId: declaration.id, event: declaration.event, ok: false, attempts, durationMs: Date.now() - started, blocked, error: lastError };
  recordHookResult(context, result, adapters);
  if (blocked) throw Object.assign(new Error(`Hook '${declaration.id}' blocked execution: ${lastError}`), { result });
  return result;
}

export function assertRepositoryCompletionAllowed(results: HookExecutionResult[]): void {
  const blockers = results.filter((result) => result.blocked);
  if (blockers.length) throw new Error(`Repository quality hooks blocked completion: ${blockers.map((item) => item.hookId).join(", ")}`);
}
