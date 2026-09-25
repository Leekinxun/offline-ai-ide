import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { mobileAuthMiddleware } from "../auth/middleware.js";
import type { MobileSession } from "../mobile/pairing.js";
import { MobileDataError, buildMobileSnapshot, buildMobileTaskDetail, commandUserSession, getMobileContext } from "../mobile/data.js";
import { mobileRevision, publishMobileInvalidation } from "../mobile/events.js";
import { dispatchRunCommand, getActiveRun, listPendingApprovals, type RunCommand, type RunCommandResult } from "../chat/runCoordinator.js";
import { TraceStore } from "../chat/traceStore.js";
import { listConversationSummaries } from "../chat/history.js";
import { startMobileRun } from "../ws/chat.js";
import { setActiveTeamId } from "../team/sessionBridge.js";

export const mobileDataRouter = Router();
mobileDataRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
mobileDataRouter.use(mobileAuthMiddleware);

function mobile(req: Request): MobileSession {
  return (req as Request & { mobileSession: MobileSession }).mobileSession;
}

function respondError(res: Response, error: unknown): void {
  if (error instanceof MobileDataError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "Mobile data unavailable" });
}

mobileDataRouter.get("/snapshot", (req, res) => {
  try {
    const context = getMobileContext(mobile(req));
    res.json(buildMobileSnapshot(context, mobileRevision(context.scope.workspaceDir)));
  } catch (error) { respondError(res, error); }
});

mobileDataRouter.get("/tasks/:id", (req, res) => {
  try {
    const context = getMobileContext(mobile(req));
    res.json(buildMobileTaskDetail(context, req.params.id));
  } catch (error) { respondError(res, error); }
});

type MobileAction = "stop" | "steer" | "approve_once" | "deny";
interface ActiveMobileCommand {
  commandId: string;
  action: MobileAction;
  taskId: string;
  runId: string;
  expectedVersion: number;
  approvalId?: string;
  message?: string;
}
interface StartMobileCommand {
  commandId: string;
  action: "start";
  taskId?: string;
  message: string;
  mode?: "ask" | "plan" | "code" | "review";
  expectedVersion?: number;
}
type MobileCommand = ActiveMobileCommand | StartMobileCommand;
interface CommandReply {
  status: number;
  body: { ok: boolean; commandId: string; result: string; message?: string; conversationId?: string; runId?: string; created?: boolean };
}
const commandCache = new Map<string, { digest: string; createdAt: number; promise: Promise<CommandReply> }>();
const commandTimes = new Map<string, number[]>();

function parseCommand(value: any): MobileCommand | null {
  const commandId = typeof value?.commandId === "string" ? value.commandId.trim() : "";
  const action = value?.action;
  const taskId = typeof value?.taskId === "string" ? value.taskId.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(commandId)) return null;
  const message = typeof value?.message === "string" ? value.message.trim() : undefined;
  if (action === "start") {
    if (!message || message.length > 4000 ||
        (taskId && !/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) ||
        (value?.mode !== undefined && !["ask", "plan", "code", "review"].includes(value.mode)) ||
        (taskId && (!Number.isSafeInteger(value?.expectedVersion) || value.expectedVersion < 0)) ||
        (!taskId && value?.expectedVersion !== undefined)) return null;
    return { commandId, action, message, ...(taskId ? { taskId, expectedVersion: value.expectedVersion } : {}), ...(value.mode ? { mode: value.mode } : {}) };
  }
  const runId = typeof value?.runId === "string" ? value.runId.trim() : "";
  const expectedVersion = value?.expectedVersion;
  if (!["stop", "steer", "approve_once", "deny"].includes(action) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(taskId) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(runId) ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
  const approvalId = typeof value?.approvalId === "string" ? value.approvalId.trim() : undefined;
  if (action === "steer" && (!message || message.length > 4000)) return null;
  if ((action === "approve_once" || action === "deny") && (!approvalId || !/^[A-Za-z0-9_-]{1,160}$/.test(approvalId))) return null;
  return { commandId, action, taskId, runId, expectedVersion, ...(message ? { message } : {}), ...(approvalId ? { approvalId } : {}) };
}

function commandFingerprint(command: MobileCommand): string {
  return crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

function limitCommands(mobileId: string): boolean {
  const now = Date.now();
  const recent = (commandTimes.get(mobileId) || []).filter((at) => now - at < 60_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  commandTimes.set(mobileId, recent);
  return true;
}

function pruneCommandCache(): void {
  const cutoff = Date.now() - 8 * 60 * 60_000;
  for (const [key, record] of commandCache) if (record.createdAt < cutoff) commandCache.delete(key);
}

async function executeCommand(session: MobileSession, command: MobileCommand): Promise<CommandReply> {
  const context = getMobileContext(session);
  if (!context.workspace.canWrite) throw new MobileDataError("Workspace is read-only", 403);
  if (command.action === "start") {
    if (command.taskId) {
      const prior = listConversationSummaries(context.scope.workspaceDir).find((task) => task.id === command.taskId);
      if (!prior) throw new MobileDataError("Task not found", 404);
      if (prior.updatedAt !== command.expectedVersion) throw new MobileDataError("Task changed; refresh before continuing", 409);
      if (getActiveRun(context.scope.workspaceDir, command.taskId)) throw new MobileDataError("Task is already running", 409);
    }
    new TraceStore(context.scope.workspaceDir).append({
      kind: "decision", action: "mobile.command.requested", correlationId: command.commandId,
      ...(command.taskId ? { conversationId: command.taskId } : {}),
      metadata: { actor: session.username, deviceId: session.id, scopeKey: session.scopeKey, command: "start" },
    });
    const scopedUser = commandUserSession(context, command.commandId);
    let result: Awaited<ReturnType<typeof startMobileRun>>;
    try {
      result = await startMobileRun(scopedUser, {
        ownerSessionToken: context.parent.token,
        ...(command.taskId ? { conversationId: command.taskId } : {}),
        message: command.message,
        ...(command.mode ? { mode: command.mode } : {}),
        requestId: command.commandId,
      });
    } finally {
      setActiveTeamId(scopedUser, null);
    }
    try {
      new TraceStore(context.scope.workspaceDir).append({
        kind: "decision", action: "mobile.command.result", correlationId: command.commandId,
        ...(result.ok ? { runId: result.runId, conversationId: result.conversationId } : command.taskId ? { conversationId: command.taskId } : {}),
        decision: result.ok ? "accepted" : result.code,
        metadata: { actor: session.username, deviceId: session.id, scopeKey: session.scopeKey, command: "start" },
      });
    } catch { /* Return the accepted run even if post-action audit storage fails. */ }
    if (result.ok) publishMobileInvalidation(context.scope.workspaceDir, "command");
    const status = result.ok ? 200 : result.code === "forbidden" ? 403 : result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : result.code === "invalid" ? 400 : 500;
    return { status, body: {
      ok: result.ok, commandId: command.commandId, result: result.ok ? "accepted" : result.code,
      ...(result.ok ? { conversationId: result.conversationId, ...(result.runId ? { runId: result.runId } : {}), created: result.created } : { message: result.message }),
    } };
  }
  const active = getActiveRun(context.scope.workspaceDir, command.taskId);
  if (!active || active.runId !== command.runId) throw new MobileDataError("Run is no longer active", 409);
  if (active.sequence !== command.expectedVersion) throw new MobileDataError("Run changed; refresh before acting", 409);
  if (command.action === "approve_once" || command.action === "deny") {
    const approval = listPendingApprovals(context.scope.workspaceDir).find((item) => item.approvalId === command.approvalId);
    if (!approval || approval.runId !== command.runId || approval.conversationId !== command.taskId) {
      throw new MobileDataError("Approval is no longer pending", 409);
    }
    if (command.action === "approve_once" && approval.risk !== "medium") {
      throw new MobileDataError("This approval requires the web interface", 403);
    }
  }

  // Record the user's intent before applying a remote side effect. The audit
  // contains only identifiers and the outcome, never command text or prompts.
  new TraceStore(context.scope.workspaceDir).append({
    kind: "decision", action: "mobile.command.requested", correlationId: command.commandId,
    runId: command.runId, conversationId: command.taskId,
    metadata: { actor: session.username, deviceId: session.id, scopeKey: session.scopeKey, command: command.action },
  });
  const scopedUser = commandUserSession(context, command.commandId);
  const base = { conversationId: command.taskId, runId: command.runId, source: "mobile" as const };
  let runCommand: RunCommand;
  switch (command.action) {
    case "stop": runCommand = { ...base, type: "stop", requestId: command.commandId }; break;
    case "steer": runCommand = { ...base, type: "steer", requestId: command.commandId, message: command.message! }; break;
    case "approve_once": runCommand = { ...base, type: "tool_approval", approvalId: command.approvalId!, decision: "allow_once" }; break;
    case "deny": runCommand = { ...base, type: "tool_approval", approvalId: command.approvalId!, decision: "deny" }; break;
  }
  let result: RunCommandResult;
  try {
    result = await dispatchRunCommand(scopedUser, runCommand);
  } finally {
    setActiveTeamId(scopedUser, null);
  }
  try {
    new TraceStore(context.scope.workspaceDir).append({
      kind: "decision", action: "mobile.command.result", correlationId: command.commandId,
      runId: command.runId, conversationId: command.taskId, decision: result.code,
      metadata: { actor: session.username, deviceId: session.id, scopeKey: session.scopeKey, command: command.action },
    });
  } catch { /* The command outcome must still be returned exactly once. */ }
  const status = result.ok ? 200 : result.code === "forbidden" ? 403 : result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : 400;
  if (result.ok) publishMobileInvalidation(context.scope.workspaceDir, command.action === "approve_once" || command.action === "deny" ? "approval" : "command");
  return { status, body: { ok: result.ok, commandId: command.commandId, result: result.code, ...(result.message ? { message: result.message } : {}) } };
}

mobileDataRouter.post("/commands", async (req, res) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "JSON request required" });
  const command = parseCommand(req.body);
  if (!command) return res.status(400).json({ error: "Invalid mobile command" });
  const session = mobile(req);
  const key = `${session.id}:${command.commandId}`;
  const digest = commandFingerprint(command);
  const existing = commandCache.get(key);
  if (existing) {
    if (existing.digest !== digest) return res.status(409).json({ error: "Command ID reused with different input" });
    try {
      const reply = await existing.promise;
      return res.status(reply.status).json(reply.body);
    } catch (error) { return respondError(res, error); }
  }
  if (!limitCommands(session.id)) return res.status(429).json({ error: "Too many mobile commands" });
  pruneCommandCache();
  const promise = executeCommand(session, command);
  commandCache.set(key, { digest, createdAt: Date.now(), promise });
  try {
    const reply = await promise;
    return res.status(reply.status).json(reply.body);
  } catch (error) {
    commandCache.delete(key);
    return respondError(res, error);
  }
});
