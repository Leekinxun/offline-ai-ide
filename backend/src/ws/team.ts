import { WebSocket } from "ws";
import type { UserSession } from "../auth/sessionManager.js";
import {
  getTeamManager,
  resolveActiveTeam,
  setActiveTeamId,
} from "../team/sessionBridge.js";
import type { TeamDetails } from "../team/teamManager.js";

type TeamWsMessage =
  | { type: "team_snapshot"; team: TeamDetails | null }
  | { type: "team_error"; content: string };

const TEAM_CONNECTIONS = new Map<string, Set<WebSocket>>();
const SOCKET_OWNERS = new WeakMap<WebSocket, UserSession>();

function sendTeam(ws: WebSocket, data: TeamWsMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastTeam(teamId: string, payload: TeamWsMessage): void {
  const sockets = TEAM_CONNECTIONS.get(teamId);
  if (!sockets) {
    return;
  }
  for (const socket of sockets) {
    sendTeam(socket, payload);
  }
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
    } catch {
      setActiveTeamId(owner, null);
      sendTeam(socket, { type: "team_snapshot", team: null });
      continue;
    }
  }
}

export function handleTeamWs(ws: WebSocket, session: UserSession): void {
  SOCKET_OWNERS.set(ws, session);
  const initialTeam = resolveActiveTeam(session);
  let currentTeamId = initialTeam?.id || null;

  if (currentTeamId) {
    const sockets = TEAM_CONNECTIONS.get(currentTeamId) || new Set<WebSocket>();
    sockets.add(ws);
    TEAM_CONNECTIONS.set(currentTeamId, sockets);
  }

  sendTeam(ws, { type: "team_snapshot", team: initialTeam });

  if (initialTeam) {
    getTeamManager(session).upsertPresence(initialTeam.id, session.username, {
      online: true,
      activity: "online",
    });
    pushTeamSnapshot(session, initialTeam.id);
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
      };

      if (data.type === "subscribe" && typeof data.teamId === "string" && data.teamId.trim()) {
        if (currentTeamId && TEAM_CONNECTIONS.has(currentTeamId)) {
          TEAM_CONNECTIONS.get(currentTeamId)?.delete(ws);
        }
        currentTeamId = data.teamId.trim();
        setActiveTeamId(session, currentTeamId);
        const sockets = TEAM_CONNECTIONS.get(currentTeamId) || new Set<WebSocket>();
        sockets.add(ws);
        TEAM_CONNECTIONS.set(currentTeamId, sockets);
        const team = getTeamManager(session).getTeamDetails(currentTeamId, session.username);
        sendTeam(ws, { type: "team_snapshot", team });
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
        pushTeamSnapshot(session, updated.id);
      }
    } catch (error) {
      sendTeam(ws, {
        type: "team_error",
        content: error instanceof Error ? error.message : "Invalid team message",
      });
    }
  });

  ws.on("close", () => {
    if (currentTeamId && TEAM_CONNECTIONS.has(currentTeamId)) {
      TEAM_CONNECTIONS.get(currentTeamId)?.delete(ws);
      if (TEAM_CONNECTIONS.get(currentTeamId)?.size === 0) {
        TEAM_CONNECTIONS.delete(currentTeamId);
      }
      const updated = getTeamManager(session).setOffline(currentTeamId, session.username);
      if (updated) {
        pushTeamSnapshot(session, currentTeamId);
      }
    }
  });
}
