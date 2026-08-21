import { WebSocket } from "ws";
import type { UserSession } from "../auth/sessionManager.js";
import {
  getTeamManager,
  resolveActiveTeam,
  setActiveTeamId,
} from "../team/sessionBridge.js";
import type { TeamDetails } from "../team/teamManager.js";
import {
  agentExecutionGraphSnapshot,
  agentSnapshot,
  canSessionManageAgentBudget,
} from "../team/agentSnapshot.js";
import type { AgentExecutionGraphSnapshot } from "../agent/executionGraph.js";
import { CollaborationStore } from "../collaboration/collaborationStore.js";
import { buildCollaborationSnapshot } from "../collaboration/snapshot.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";

type TeamWsMessage =
  | { type: "team_snapshot"; team: TeamDetails | null }
  | { type: "agent_snapshot"; sequence: number; agents: unknown[] }
  | { type: "agent_update"; sequence: number; agents: unknown[] }
  | AgentGraphWsMessage
  | { type: "collaboration_snapshot" | "collaboration_update"; collaboration: unknown }
  | { type: "team_error"; content: string };
type AgentWsMessage = Extract<TeamWsMessage, { type: "agent_snapshot" | "agent_update" }>;
export type AgentGraphWsMessage = {
  type: "agent_graph_snapshot" | "agent_graph_event";
  sequence: number;
  cursor: number;
  revision: string;
  graph: AgentExecutionGraphSnapshot;
};

interface AgentGraphEventState {
  sequence: number;
  history: AgentGraphWsMessage[];
}

const TEAM_CONNECTIONS = new Map<string, Set<WebSocket>>();
const SESSION_CONNECTIONS = new Map<string, Set<WebSocket>>();
const SOCKET_OWNERS = new WeakMap<WebSocket, UserSession>();
const SOCKET_GRAPH_CURSORS = new WeakMap<WebSocket, Map<string, number>>();
const PRESENCE_SOCKETS = new Map<string, Map<string, number>>();
const AGENT_EVENTS = new Map<string, { sequence: number; history: TeamWsMessage[] }>();
const AGENT_GRAPH_EVENTS = new Map<string, AgentGraphEventState>();
const GRAPH_HISTORY_LIMIT = 100;

function agentWorkspace(session: UserSession): string { return session.workspaceDir; }
function normalizeAgent(member: any) {
  const id = typeof member.id === "string" && member.id ? member.id : `teammate:${member.name}`;
  return { ...member, id, version: typeof member.version === "number" ? member.version : 0,
    revision: typeof member.version === "number" ? member.version : 0,
    resource: { type: "agent", id, workspaceDir: member.worktreePath || null },
    capabilities: Array.isArray(member.capabilities) ? [...member.capabilities] : [] };
}

/** Recipient-specific derivation used by initial snapshots, live broadcasts,
 * and history replay. Raw agent events never cross the socket boundary. */
export function deriveAgentEvent(payload: AgentWsMessage, canManageBudget: boolean): AgentWsMessage {
  return { ...payload, agents: payload.agents.map((member) => agentSnapshot(member as Record<string, any>, canManageBudget)) };
}

function sendAgentEvent(ws: WebSocket, payload: AgentWsMessage, owner: UserSession): void {
  sendAgentEventForRecipient(ws, payload, canSessionManageAgentBudget(owner));
}

export function sendAgentEventForRecipient(ws: WebSocket, payload: AgentWsMessage, canManageBudget: boolean): void {
  sendTeam(ws, deriveAgentEvent(payload, canManageBudget));
}

function agentState(workspace: string) { let state = AGENT_EVENTS.get(workspace); if (!state) { state = { sequence: 0, history: [] }; AGENT_EVENTS.set(workspace, state); } return state; }

function graphScope(session: UserSession, teamId: string | null): string {
  return teamId
    ? `team\0${session.workspaceDir}\0${teamId}`
    : `session\0${session.workspaceDir}\0${session.token}`;
}

function graphState(scope: string): AgentGraphEventState {
  let state = AGENT_GRAPH_EVENTS.get(scope);
  if (!state) {
    state = { sequence: 0, history: [] };
    AGENT_GRAPH_EVENTS.set(scope, state);
  }
  return state;
}

function graphMessage(
  type: AgentGraphWsMessage["type"],
  sequence: number,
  graph: AgentExecutionGraphSnapshot,
): AgentGraphWsMessage {
  return { type, sequence, cursor: sequence, revision: graph.revision, graph };
}

function markGraphScopeDelivered(ws: WebSocket, scope: string, cursor: number): void {
  const cursors = SOCKET_GRAPH_CURSORS.get(ws) || new Map<string, number>();
  cursors.set(scope, Math.max(cursors.get(scope) ?? -1, cursor));
  SOCKET_GRAPH_CURSORS.set(ws, cursors);
}

function sendGraphMessage(ws: WebSocket, scope: string, payload: AgentGraphWsMessage): void {
  if (sendTeam(ws, payload)) markGraphScopeDelivered(ws, scope, payload.cursor);
}

function sendGraphSnapshot(ws: WebSocket, session: UserSession, teamId: string | null): void {
  const scope = graphScope(session, teamId);
  let graph: AgentExecutionGraphSnapshot;
  try {
    graph = agentExecutionGraphSnapshot(session);
  } catch {
    // The graph projection is additive. A malformed/unavailable durable graph
    // source must not prevent legacy team and agent snapshots from connecting.
    return;
  }
  sendGraphMessage(ws, scope, graphMessage("agent_graph_snapshot", graphState(scope).sequence, graph));
}

function graphCursor(data: { afterGraphSequence?: number; afterGraphCursor?: number; graphCursor?: number }): number | null {
  for (const candidate of [data.afterGraphSequence, data.afterGraphCursor, data.graphCursor]) {
    if (Number.isSafeInteger(candidate) && candidate! >= 0) return candidate!;
  }
  return null;
}

function sendGraphReplayOrSnapshot(
  ws: WebSocket,
  session: UserSession,
  teamId: string,
  after: number | null,
): void {
  const scope = graphScope(session, teamId);
  const state = graphState(scope);
  const delivered = SOCKET_GRAPH_CURSORS.get(ws)?.get(scope);
  // Never resend entries this socket has already received, but do replay any
  // events produced while it was subscribed to another team.
  if (delivered === state.sequence) return;
  const resumeAfter = after === null ? null : Math.max(after, delivered ?? -1);
  const oldest = state.history[0]?.sequence;
  const hasGap = resumeAfter === null
    || resumeAfter > state.sequence
    || (state.history.length === 0 ? resumeAfter !== state.sequence : resumeAfter < oldest! - 1);
  if (hasGap) {
    sendGraphSnapshot(ws, session, teamId);
    return;
  }

  const replay = state.history.filter((event) => event.sequence > resumeAfter!);
  if (replay.length === 0) {
    sendGraphSnapshot(ws, session, teamId);
    return;
  }
  for (const event of replay) sendGraphMessage(ws, scope, event);
}

function sendTeam(ws: WebSocket, data: TeamWsMessage): boolean {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

export function pushTeamSnapshot(session: UserSession, teamId: string): void {
  const manager = getTeamManager(session);
  const sockets = TEAM_CONNECTIONS.get(teamId);
  if (!sockets) {
    return;
  }
  for (const socket of sockets) {
    const owner = SOCKET_OWNERS.get(socket);
    if (!owner) {
      continue;
    }
    try {
      const team = manager.getTeamDetails(teamId, owner.username);
      sendTeam(socket, { type: "team_snapshot", team });
      sendTeam(socket, { type: "collaboration_update", collaboration: buildCollaborationSnapshot(owner, team) });
    } catch {
      setActiveTeamId(owner, null);
      sendTeam(socket, { type: "team_snapshot", team: null });
      continue;
    }
  }
}

/** Publish an ordered, replayable agent update to every session on this workspace. */
export function pushAgentUpdate(session: UserSession, agents = session.teammateManager.listDetails().map(normalizeAgent)): void {
  const workspace = agentWorkspace(session);
  const state = agentState(workspace);
  const payload: AgentWsMessage = { type: "agent_update", sequence: ++state.sequence, agents: agents.map(normalizeAgent) };
  state.history.push(payload);
  state.history = state.history.slice(-100);
  for (const sockets of TEAM_CONNECTIONS.values()) for (const socket of sockets) {
    const owner = SOCKET_OWNERS.get(socket);
    if (owner && agentWorkspace(owner) === workspace) sendAgentEvent(socket, payload, owner);
  }

  const activeTeam = resolveActiveTeam(session);
  const teamId = activeTeam?.id || null;
  const scope = graphScope(session, teamId);
  const graphEvents = graphState(scope);
  let graph: AgentExecutionGraphSnapshot;
  try {
    graph = agentExecutionGraphSnapshot(session);
  } catch {
    return;
  }
  const graphEvent = graphMessage("agent_graph_event", ++graphEvents.sequence, graph);
  graphEvents.history.push(graphEvent);
  graphEvents.history = graphEvents.history.slice(-GRAPH_HISTORY_LIMIT);

  const recipients = teamId ? TEAM_CONNECTIONS.get(teamId) : SESSION_CONNECTIONS.get(session.token);
  if (!recipients) return;
  for (const socket of recipients) {
    const owner = SOCKET_OWNERS.get(socket);
    if (!owner || agentWorkspace(owner) !== workspace) continue;
    if (teamId) {
      try {
        const recipientTeam = getTeamManager(owner).getTeamDetails(teamId, owner.username);
        if (recipientTeam.workspaceDir !== workspace) continue;
      } catch {
        continue;
      }
    } else if (owner.token !== session.token) {
      continue;
    }
    sendGraphMessage(socket, scope, graphEvent);
  }
}

function addPresence(teamId: string, username: string): boolean {
  const users = PRESENCE_SOCKETS.get(teamId) || new Map<string, number>();
  const wasOffline = !users.get(username); users.set(username, (users.get(username) || 0) + 1); PRESENCE_SOCKETS.set(teamId, users); return wasOffline;
}
function removePresence(teamId: string, username: string): boolean {
  const users = PRESENCE_SOCKETS.get(teamId); if (!users) return false;
  const remaining = (users.get(username) || 0) - 1;
  if (remaining > 0) { users.set(username, remaining); return false; }
  users.delete(username); if (!users.size) PRESENCE_SOCKETS.delete(teamId); return true;
}

export function handleTeamWs(ws: WebSocket, session: UserSession): void {
  SOCKET_OWNERS.set(ws, session);
  const sessionSockets = SESSION_CONNECTIONS.get(session.token) || new Set<WebSocket>();
  sessionSockets.add(ws);
  SESSION_CONNECTIONS.set(session.token, sessionSockets);
  const initialTeam = resolveActiveTeam(session);
  let currentTeamId = initialTeam?.id || null;

  if (currentTeamId) {
    const sockets = TEAM_CONNECTIONS.get(currentTeamId) || new Set<WebSocket>();
    sockets.add(ws);
    TEAM_CONNECTIONS.set(currentTeamId, sockets);
  }

  sendTeam(ws, { type: "team_snapshot", team: initialTeam });
  sendTeam(ws, { type: "collaboration_snapshot", collaboration: buildCollaborationSnapshot(session, initialTeam) });
  const eventState = agentState(agentWorkspace(session));
  sendAgentEvent(ws, { type: "agent_snapshot", sequence: eventState.sequence, agents: session.teammateManager.listDetails().map(normalizeAgent) }, session);
  sendGraphSnapshot(ws, session, currentTeamId);
  // The manager is file-backed and may be updated by a restarted/background
  // process without emitting in-process events. Polling is deliberately only a
  // fallback; normal route controls call pushAgentUpdate immediately.
  let agentFingerprint = JSON.stringify(session.teammateManager.listDetails().map(normalizeAgent));
  const pollAgents = setInterval(() => {
    try {
      session.teammateManager.reconcile();
      const agents = session.teammateManager.listDetails().map(normalizeAgent);
      const next = JSON.stringify(agents);
      if (next !== agentFingerprint) {
        agentFingerprint = next;
        pushAgentUpdate(session, agents);
      }
    } catch { /* a polling failure must not terminate the socket */ }
  }, 5_000);
  pollAgents.unref();

  if (initialTeam) {
    new CollaborationStore(session.workspaceDir).upsertPresence({ subject: { kind: "human", id: session.username }, online: true, socketDelta: 1, activity: "online" });
    if (addPresence(initialTeam.id, session.username)) {
      getTeamManager(session).upsertPresence(initialTeam.id, session.username, { online: true, activity: "online" });
      pushTeamSnapshot(session, initialTeam.id);
    }
  }

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString()) as {
        type?: string;
        teamId?: string;
        activeFilePath?: string;
        cursorLine?: number;
        cursorColumn?: number;
        activity?: string;
        afterSequence?: number;
        afterGraphSequence?: number;
        afterGraphCursor?: number;
        graphCursor?: number;
        path?: string;
        version?: number;
        digest?: string;
        savedDigest?: string;
        baseDigest?: string;
        revision?: string;
        expectedBufferVersion?: number;
      };

      if (data.type === "subscribe" && typeof data.teamId === "string" && data.teamId.trim()) {
        // Authorize before changing the socket set or the active-session selection.
        const requestedTeamId = data.teamId.trim();
        const team = getTeamManager(session).getTeamDetails(requestedTeamId, session.username);
        if (team.workspaceDir !== session.workspaceDir) throw new Error("403 Team workspace does not match the authorized session workspace");
        if (requestedTeamId === currentTeamId) {
          sendTeam(ws, { type: "team_snapshot", team });
          sendTeam(ws, { type: "collaboration_snapshot", collaboration: buildCollaborationSnapshot(session, team) });
          const events = agentState(agentWorkspace(session));
          const after = typeof data.afterSequence === "number" ? data.afterSequence : -1;
          for (const event of events.history) if ((event as any).sequence > after) event.type === "agent_update" || event.type === "agent_snapshot" ? sendAgentEvent(ws, event, session) : sendTeam(ws, event);
          sendGraphReplayOrSnapshot(ws, session, requestedTeamId, graphCursor(data));
          return;
        }
        if (currentTeamId && TEAM_CONNECTIONS.has(currentTeamId)) {
          TEAM_CONNECTIONS.get(currentTeamId)?.delete(ws);
          if (removePresence(currentTeamId, session.username)) {
            const offline = getTeamManager(session).setOffline(currentTeamId, session.username);
            if (offline) pushTeamSnapshot(session, currentTeamId);
          }
          new CollaborationStore(session.workspaceDir).upsertPresence({ subject: { kind: "human", id: session.username }, online: false, socketDelta: -1, activity: "offline" });
        }
        currentTeamId = requestedTeamId;
        setActiveTeamId(session, currentTeamId);
        const sockets = TEAM_CONNECTIONS.get(currentTeamId) || new Set<WebSocket>();
        sockets.add(ws);
        TEAM_CONNECTIONS.set(currentTeamId, sockets);
        if (addPresence(currentTeamId, session.username)) getTeamManager(session).upsertPresence(currentTeamId, session.username, { online: true, activity: "online" });
        new CollaborationStore(session.workspaceDir).upsertPresence({ subject: { kind: "human", id: session.username }, online: true, socketDelta: 1, activity: "online" });
        sendTeam(ws, { type: "team_snapshot", team });
        sendTeam(ws, { type: "collaboration_snapshot", collaboration: buildCollaborationSnapshot(session, team) });
        const events = agentState(agentWorkspace(session));
        const after = typeof data.afterSequence === "number" ? data.afterSequence : -1;
        for (const event of events.history) if ((event as any).sequence > after) event.type === "agent_update" || event.type === "agent_snapshot" ? sendAgentEvent(ws, event, session) : sendTeam(ws, event);
        sendGraphReplayOrSnapshot(ws, session, requestedTeamId, graphCursor(data));
        return;
      }

      if (data.type === "presence") {
        const team = resolveActiveTeam(session);
        if (!team) {
          sendTeam(ws, { type: "team_error", content: "No active team" });
          return;
        }
        const updated = getTeamManager(session).upsertPresence(team.id, session.username, {
          online: true,
          activeFilePath:
            typeof data.activeFilePath === "string" ? data.activeFilePath : undefined,
          cursorLine:
            typeof data.cursorLine === "number" ? data.cursorLine : undefined,
          cursorColumn:
            typeof data.cursorColumn === "number" ? data.cursorColumn : undefined,
          activity: typeof data.activity === "string" ? data.activity : undefined,
        });
        new CollaborationStore(session.workspaceDir).upsertPresence({ subject: { kind: "human", id: session.username }, online: true, activePath: typeof data.activeFilePath === "string" ? data.activeFilePath : undefined, cursorLine: typeof data.cursorLine === "number" ? data.cursorLine : undefined, cursorColumn: typeof data.cursorColumn === "number" ? data.cursorColumn : undefined, activity: typeof data.activity === "string" ? data.activity : undefined });
        pushTeamSnapshot(session, updated.id);
        return;
      }

      if (data.type === "buffer_register") {
        if (!canWriteActiveWorkspace(session)) { sendTeam(ws, { type: "team_error", content: "403 Active team role is read-only" }); return; }
        new CollaborationStore(session.workspaceDir).registerBuffer({ username: session.username, path: data.path || "", version: data.version as number, digest: data.digest || "", savedDigest: data.savedDigest || "", ...(data.baseDigest ? { baseDigest: data.baseDigest } : {}), revision: data.revision || "" });
        const team = resolveActiveTeam(session); if (team) pushTeamSnapshot(session, team.id); else sendTeam(ws, { type: "collaboration_update", collaboration: new CollaborationStore(session.workspaceDir).snapshot() });
        return;
      }

      if (data.type === "buffer_close") {
        if (!canWriteActiveWorkspace(session)) { sendTeam(ws, { type: "team_error", content: "403 Active team role is read-only" }); return; }
        new CollaborationStore(session.workspaceDir).closeBuffer(session.username, data.path || "", data.expectedBufferVersion as number);
        const team = resolveActiveTeam(session); if (team) pushTeamSnapshot(session, team.id); else sendTeam(ws, { type: "collaboration_update", collaboration: new CollaborationStore(session.workspaceDir).snapshot() });
      }
    } catch (error) {
      sendTeam(ws, {
        type: "team_error",
        content: error instanceof Error ? error.message : "Invalid team message",
      });
    }
  });

  ws.on("close", () => {
    clearInterval(pollAgents);
    SESSION_CONNECTIONS.get(session.token)?.delete(ws);
    if (SESSION_CONNECTIONS.get(session.token)?.size === 0) SESSION_CONNECTIONS.delete(session.token);
    if (currentTeamId && TEAM_CONNECTIONS.has(currentTeamId)) {
      TEAM_CONNECTIONS.get(currentTeamId)?.delete(ws);
      if (TEAM_CONNECTIONS.get(currentTeamId)?.size === 0) {
        TEAM_CONNECTIONS.delete(currentTeamId);
      }
      if (removePresence(currentTeamId, session.username)) {
        const updated = getTeamManager(session).setOffline(currentTeamId, session.username);
        if (updated) pushTeamSnapshot(session, currentTeamId);
      }
      try { new CollaborationStore(session.workspaceDir).upsertPresence({ subject: { kind: "human", id: session.username }, online: false, socketDelta: -1, activity: "offline" }); } catch { /* durable presence ages out after restart */ }
    }
  });
}
