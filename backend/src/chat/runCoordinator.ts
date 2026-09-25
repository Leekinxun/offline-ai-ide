import { WebSocket } from "ws";
import type { AgentMode, WsServerMessage } from "../agent/types.js";
import { sessionManager, type UserSession } from "../auth/sessionManager.js";
import { ToolApprovalSession, type ToolApprovalDecision, type ToolApprovalRequestEvent } from "../agent/toolApproval.js";
import type { ChatAttachmentRef } from "./attachments.js";
import type { ExecutionPlan } from "./executionPlans.js";
import type { AgentRunRecorder } from "./runHistory.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import { canWriteActiveWorkspace, getTeamManager, resolveActiveTeam } from "../team/sessionBridge.js";
import { subscribeTeamAccessChanges } from "../team/teamManager.js";

export interface PendingUserMessage {
  requestId: string;
  message: string;
  attachments?: ChatAttachmentRef[];
  context?: { path: string; content: string; language: string; selection?: string };
  conversationId: string;
  mode: AgentMode;
  modelName: string;
  selectedModelName?: string;
  executionPlan?: ExecutionPlan;
}

export interface RunControlState {
  stopped: boolean;
  requestId?: string;
  stop: (requestId?: string) => void;
  reset: () => void;
  createAbortSignal: () => AbortSignal;
}

function createRunControlState(): RunControlState {
  let abortController = new AbortController();
  return {
    stopped: false,
    stop(requestId?: string) {
      this.stopped = true;
      this.requestId = requestId;
      abortController.abort();
    },
    reset() {
      abortController.abort();
      this.stopped = false;
      this.requestId = undefined;
      abortController = new AbortController();
    },
    createAbortSignal() { return abortController.signal; },
  };
}

export interface ChatRunSnapshot {
  workspaceDir: string;
  conversationId: string;
  runId: string;
  ownerUsername: string;
  status: "running" | "stopping";
  mode: AgentMode;
  modelName?: string;
  startedAt: number;
  updatedAt: number;
  sequence: number;
  pendingApprovals: PendingRunApproval[];
}

export interface ChatRunEvent {
  workspaceDir: string;
  conversationId: string;
  runId: string;
  sequence: number;
  payload: WsServerMessage;
}

export type RunCommand = (
  | { type: "stop"; conversationId: string; runId: string; requestId?: string }
  | { type: "steer"; conversationId: string; runId: string; requestId: string; message: string }
  | { type: "tool_approval"; conversationId: string; runId: string; approvalId: string; decision: ToolApprovalDecision }
  | { type: "tool_approval_all"; conversationId: string; runId: string }
) & { source: "web" | "mobile" };

export interface PendingRunApproval {
  approvalId: string;
  runId: string;
  conversationId: string;
  name: string;
  risk: "medium" | "high";
  summary: string;
  createdAt: number;
  allowedDecisions: ToolApprovalDecision[];
}

export interface RunCommandResult {
  ok: boolean;
  code: "accepted" | "not_found" | "forbidden" | "conflict" | "invalid";
  message?: string;
  requestId?: string;
}

type EventListener = (event: ChatRunEvent) => void;
const runs = new Map<string, ActiveChatRun>();
const listeners = new Map<string, Set<EventListener>>();

subscribeTeamAccessChanges((change) => {
  if (change.role !== "viewer" && change.role !== null) return;
  for (const run of runs.values()) {
    if (run.teamId === change.teamId && run.ownerUsername === change.username) {
      run.forceStop("Team permission changed; stopping current AI run...");
    }
  }
});

const permissionSweep = setInterval(() => {
  for (const run of runs.values()) {
    try { run.stopIfAccessRevoked(); }
    catch { run.forceStop("Workspace permission could not be verified; stopping current AI run..."); }
  }
}, 5_000);
permissionSweep.unref?.();

function key(workspaceDir: string, conversationId: string): string {
  return `${workspaceDir}\u0000${conversationId}`;
}

export function subscribeRunEvents(workspaceDir: string, listener: EventListener): () => void {
  let set = listeners.get(workspaceDir);
  if (!set) { set = new Set(); listeners.set(workspaceDir, set); }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set?.size === 0) listeners.delete(workspaceDir);
  };
}

export function getActiveRun(workspaceDir: string, conversationId: string): ChatRunSnapshot | null {
  return runs.get(key(workspaceDir, conversationId))?.snapshot() || null;
}

/** Internal connection bridge; external callers should use snapshots and commands. */
export function getActiveRunContext(workspaceDir: string, conversationId: string): ActiveChatRun | null {
  return runs.get(key(workspaceDir, conversationId)) || null;
}

export function findActiveRunForApproval(workspaceDir: string, approvalId: string): ActiveChatRun | null {
  return [...runs.values()].find((run) =>
    run.workspaceDir === workspaceDir && Boolean(run.approvals.getPending(approvalId))
  ) || null;
}

export function listActiveRuns(workspaceDir: string): ChatRunSnapshot[] {
  return [...runs.values()].filter((run) => run.workspaceDir === workspaceDir).map((run) => run.snapshot());
}

export function listPendingApprovals(workspaceDir: string): PendingRunApproval[] {
  return listActiveRuns(workspaceDir).flatMap((run) => run.pendingApprovals);
}

export class ActiveChatRun {
  readonly controlState = createRunControlState();
  readonly steeringQueue: PendingUserMessage[] = [];
  readonly approvals: ToolApprovalSession;
  readonly transport: WebSocket;
  readonly workspaceDir: string;
  readonly conversationId: string;
  readonly ownerUsername: string;
  readonly ownerSessionToken: string;
  readonly teamId: string | null;
  private readonly ownerSession: UserSession;
  private readonly ownerSessionRegistered: boolean;
  private recorder: AgentRunRecorder;
  private sequence = 0;
  private closed = false;
  private acceptingSteering = true;
  private readonly pendingSteering = new Set<Promise<RunCommandResult>>();
  private readonly queueSteering: (session: UserSession, command: Extract<RunCommand, { type: "steer" }>) => Promise<RunCommandResult>;

  constructor(input: {
    session: UserSession;
    ownerSessionToken?: string;
    recorder: AgentRunRecorder;
    queueSteering: (session: UserSession, command: Extract<RunCommand, { type: "steer" }>) => Promise<RunCommandResult>;
  }) {
    this.workspaceDir = input.session.workspaceDir;
    this.conversationId = input.recorder.conversationId;
    this.ownerUsername = input.session.username;
    this.ownerSessionToken = input.ownerSessionToken || input.session.token;
    this.ownerSession = input.session;
    this.ownerSessionRegistered = Boolean(sessionManager.getSession(this.ownerSessionToken, { touch: false }));
    this.teamId = resolveActiveTeam(input.session)?.id || null;
    this.recorder = input.recorder;
    this.queueSteering = input.queueSteering;
    this.approvals = new ToolApprovalSession((request) => {
      this.emit({ type: "tool_approval_request", ...request });
    });
    // The agent only uses readyState and send. The transport survives browser
    // disconnects so a run can finish and be observed by another device.
    this.transport = {
      readyState: WebSocket.OPEN,
      send: (serialized: string) => this.emit(JSON.parse(serialized) as WsServerMessage),
    } as WebSocket;
  }

  get runId(): string { return this.recorder.runId; }
  get currentRecorder(): AgentRunRecorder { return this.recorder; }

  setRecorder(recorder: AgentRunRecorder): boolean {
    if (recorder.conversationId !== this.conversationId) throw new Error("Run conversation changed");
    if (this.controlState.stopped || this.closed) return false;
    this.recorder = recorder;
    this.controlState.reset();
    this.acceptingSteering = true;
    return true;
  }

  async closeSteeringGate(): Promise<void> {
    this.acceptingSteering = false;
    await Promise.allSettled([...this.pendingSteering]);
  }

  stopIfAccessRevoked(): void {
    if (this.closed || this.controlState.stopped) return;
    if (this.ownerSessionRegistered && !sessionManager.getSession(this.ownerSessionToken, { touch: false })) {
      this.forceStop("Session ended; stopping current AI run...");
      return;
    }
    if (!canWriteActiveWorkspace(this.ownerSession)) {
      this.forceStop("Workspace permission changed; stopping current AI run...");
      return;
    }
    if (this.teamId) {
      try {
        const team = getTeamManager(this.ownerSession).getTeamDetails(this.teamId, this.ownerUsername);
        if (team.workspaceDir === this.workspaceDir && team.role !== "viewer") return;
      } catch { /* The owner is no longer a team member. */ }
      this.forceStop("Team permission changed; stopping current AI run...");
    }
  }

  forceStop(content = "Stopping current AI run...", requestId?: string): boolean {
    if (this.closed || this.controlState.stopped) return false;
    this.controlState.stop(requestId);
    this.approvals.cancelAll();
    this.steeringQueue.splice(0);
    this.emit({ type: "stopped", ...(requestId ? { requestId } : {}), content });
    return true;
  }

  snapshot(): ChatRunSnapshot {
    const record = this.recorder.snapshot();
    return {
      workspaceDir: this.workspaceDir,
      conversationId: this.conversationId,
      runId: record.runId,
      ownerUsername: this.ownerUsername,
      status: this.controlState.stopped ? "stopping" : "running",
      mode: record.mode,
      modelName: record.modelName,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      sequence: this.sequence,
      pendingApprovals: this.approvals.listPending(this.conversationId).map((approval) => ({
        approvalId: approval.approvalId,
        runId: this.runId,
        conversationId: this.conversationId,
        name: approval.name,
        risk: approval.risk,
        summary: redactSecrets(approval.scope).slice(0, 280),
        createdAt: approval.createdAt,
        allowedDecisions: approval.risk === "high" ? ["deny"] : ["deny", "allow_once"],
      })),
    };
  }

  emit(payload: WsServerMessage): void {
    if (this.closed) return;
    const event: ChatRunEvent = {
      workspaceDir: this.workspaceDir,
      conversationId: this.conversationId,
      runId: this.runId,
      sequence: ++this.sequence,
      payload,
    };
    for (const listener of listeners.get(this.workspaceDir) || []) {
      try { listener(event); } catch { /* One client must not break the run. */ }
    }
  }

  async command(session: UserSession, command: RunCommand): Promise<RunCommandResult> {
    if (this.closed || command.runId !== this.runId) return { ok: false, code: "conflict", message: "Run is no longer active" };
    if (session.username !== this.ownerUsername || session.workspaceDir !== this.workspaceDir || !canWriteActiveWorkspace(session)) {
      return { ok: false, code: "forbidden", message: "Current workspace permission does not allow this action" };
    }
    if (this.teamId) {
      try {
        const team = getTeamManager(session).getTeamDetails(this.teamId, session.username);
        if (team.workspaceDir !== this.workspaceDir || team.role === "viewer") return { ok: false, code: "forbidden" };
      } catch { return { ok: false, code: "forbidden" }; }
    }
    if (command.type === "stop") {
      if (!this.forceStop("Stopping current AI run...", command.requestId)) {
        return { ok: false, code: "conflict", message: "Run is already stopping" };
      }
      return { ok: true, code: "accepted", requestId: command.requestId };
    }
    if (this.controlState.stopped) return { ok: false, code: "conflict", message: "Run is stopping" };
    if (command.type === "steer") {
      if (!this.acceptingSteering) return { ok: false, code: "conflict", message: "Run is finishing" };
      const pending = this.queueSteering(session, command);
      this.pendingSteering.add(pending);
      try { return await pending; }
      finally { this.pendingSteering.delete(pending); }
    }
    if (command.type === "tool_approval_all") {
      if (command.source === "mobile") return { ok: false, code: "forbidden", message: "Approve all is unavailable on mobile" };
      this.approvals.allowConversation(this.conversationId);
      return { ok: true, code: "accepted" };
    }
    const pending = this.approvals.getPending(command.approvalId);
    if (!pending) return { ok: false, code: "conflict", message: "Tool approval request is no longer active" };
    if (command.source === "mobile" && (command.decision === "allow_session" || (pending.risk === "high" && command.decision !== "deny"))) {
      return { ok: false, code: "forbidden", message: "This approval requires the web interface" };
    }
    const resolved = this.approvals.resolve(command.approvalId, command.decision);
    return resolved ? { ok: true, code: "accepted" } : { ok: false, code: "conflict", message: "Tool approval request is no longer active" };
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.acceptingSteering = false;
    this.approvals.cancelAll();
    runs.delete(key(this.workspaceDir, this.conversationId));
  }
}

export function createActiveRun(input: ConstructorParameters<typeof ActiveChatRun>[0]): ActiveChatRun {
  const runKey = key(input.session.workspaceDir, input.recorder.conversationId);
  if (runs.has(runKey)) throw new Error("An AI run is already active in this conversation");
  const run = new ActiveChatRun(input);
  runs.set(runKey, run);
  return run;
}

export async function dispatchRunCommand(session: UserSession, command: RunCommand): Promise<RunCommandResult> {
  const run = runs.get(key(session.workspaceDir, command.conversationId));
  if (!run) return { ok: false, code: "not_found", message: "No active run for this conversation" };
  return run.command(session, command);
}

/** Called when a desktop session is explicitly revoked (logout, password reset, expiry). */
export function stopRunsForSession(token: string): number {
  let stopped = 0;
  for (const run of runs.values()) {
    if (run.ownerSessionToken === token && run.forceStop("Session ended; stopping current AI run...")) stopped += 1;
  }
  return stopped;
}
