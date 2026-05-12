import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TeamDetails, TeamSummary, TeamRole } from "../types";

interface TeamStateResponse {
  teams?: TeamSummary[];
  activeTeam?: TeamDetails | null;
  activeTeamId?: string | null;
}

interface JoinTeamResponse {
  team: TeamDetails;
  workspaceDir: string;
}

export function useTeam(
  token: string,
  workspaceDir: string,
  onWorkspaceSync?: (path: string) => void
) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [activeTeam, setActiveTeam] = useState<TeamDetails | null>(null);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const onWorkspaceSyncRef = useRef(onWorkspaceSync);

  useEffect(() => {
    onWorkspaceSyncRef.current = onWorkspaceSync;
  }, [onWorkspaceSync]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/team/state", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to load team state");
      }
      const payload = (await res.json()) as TeamStateResponse;
      setTeams(Array.isArray(payload.teams) ? payload.teams : []);
      setActiveTeam(payload.activeTeam || null);
      setActiveTeamId(payload.activeTeamId || payload.activeTeam?.id || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team state");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const postJson = useCallback(
    async <T,>(url: string, body: Record<string, unknown>): Promise<T> => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Request failed");
      }
      return payload as T;
    },
    [token]
  );

  const createTeam = useCallback(
    async (name: string, targetWorkspaceDir?: string) => {
      const team = await postJson<TeamDetails>("/api/team/create", {
        name,
        workspaceDir: targetWorkspaceDir || workspaceDir,
      });
      setActiveTeam(team);
      setActiveTeamId(team.id);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "subscribe", teamId: team.id }));
      }
      await refresh();
      onWorkspaceSyncRef.current?.(team.workspaceDir);
      return team;
    },
    [postJson, refresh, workspaceDir]
  );

  const joinTeam = useCallback(
    async (code: string) => {
      const result = await postJson<JoinTeamResponse>("/api/team/join", { code });
      setActiveTeam(result.team);
      setActiveTeamId(result.team.id);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "subscribe", teamId: result.team.id }));
      }
      await refresh();
      onWorkspaceSyncRef.current?.(result.workspaceDir);
      return result.team;
    },
    [postJson, refresh]
  );

  const switchTeam = useCallback(
    async (teamId: string) => {
      const result = await postJson<JoinTeamResponse>("/api/team/switch", { teamId });
      setActiveTeam(result.team);
      setActiveTeamId(result.team.id);
      await refresh();
      onWorkspaceSyncRef.current?.(result.workspaceDir);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "subscribe", teamId }));
      }
      return result.team;
    },
    [postJson, refresh]
  );

  const createInvite = useCallback(
    async (teamId: string, role: TeamRole = "member") => {
      return postJson<{ code: string; role: TeamRole; createdBy: string; createdAt: number }>(
        "/api/team/invite",
        { teamId, role }
      );
    },
    [postJson]
  );

  const setClaim = useCallback(
    async (teamId: string, path: string, claimed: boolean) => {
      const team = await postJson<TeamDetails>("/api/team/claim", {
        teamId,
        path,
        claimed,
      });
      setActiveTeam(team);
      await refresh();
      return team;
    },
    [postJson, refresh]
  );

  const updateMemberRole = useCallback(
    async (teamId: string, username: string, role: TeamRole) => {
      const team = await postJson<TeamDetails>("/api/team/members/role", {
        teamId,
        username,
        role,
      });
      setActiveTeam(team);
      await refresh();
      return team;
    },
    [postJson, refresh]
  );

  const removeMember = useCallback(
    async (teamId: string, username: string) => {
      await postJson<{ status: string }>("/api/team/members/remove", {
        teamId,
        username,
      });
      await refresh();
    },
    [postJson, refresh]
  );

  const transferOwnership = useCallback(
    async (teamId: string, username: string) => {
      const team = await postJson<TeamDetails>("/api/team/members/transfer-owner", {
        teamId,
        username,
      });
      setActiveTeam(team);
      await refresh();
      return team;
    },
    [postJson, refresh]
  );

  const leaveTeam = useCallback(
    async (teamId: string) => {
      await postJson<{ status: string }>("/api/team/leave", {
        teamId,
      });
      setActiveTeam(null);
      setActiveTeamId(null);
      await refresh();
    },
    [postJson, refresh]
  );

  const sendPresence = useCallback(
    (input: {
      activeFilePath?: string | null;
      cursorLine?: number;
      cursorColumn?: number;
      activity?: string;
    }) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        return;
      }
      wsRef.current.send(
        JSON.stringify({
          type: "presence",
          activeFilePath: input.activeFilePath || undefined,
          cursorLine: input.cursorLine,
          cursorColumn: input.cursorColumn,
          activity: input.activity,
        })
      );
    },
    []
  );

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${window.location.host}/ws/team?token=${encodeURIComponent(token)}`
    );

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (activeTeamId) {
        ws.send(JSON.stringify({ type: "subscribe", teamId: activeTeamId }));
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
        setConnected(false);
        reconnectTimerRef.current = window.setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as
        | { type: "team_snapshot"; team: TeamDetails | null }
        | { type: "team_error"; content: string };

      if (data.type === "team_snapshot") {
        const snapshotTeam = data.team;
        setActiveTeam(snapshotTeam);
        setActiveTeamId(snapshotTeam?.id || null);
        if (snapshotTeam) {
          setTeams((prev) => {
            const others = prev.filter((entry) => entry.id !== snapshotTeam.id);
            return [...others, snapshotTeam].sort((a, b) => a.name.localeCompare(b.name));
          });
        }
      } else if (data.type === "team_error") {
        setError(data.content);
      }
    };

    wsRef.current = ws;
  }, [activeTeamId, token]);

  useEffect(() => {
    void refresh();
    connect();
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect, refresh]);

  useEffect(() => {
    void refresh();
  }, [workspaceDir, refresh]);

  useEffect(() => {
    if (activeTeamId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", teamId: activeTeamId }));
    }
  }, [activeTeamId]);

  const onlineMembers = useMemo(
    () => activeTeam?.presence.filter((entry) => entry.online) || [],
    [activeTeam]
  );

  return {
    teams,
    activeTeam,
    activeTeamId,
    connected,
    loading,
    error,
    onlineMembers,
    refresh,
    createTeam,
    joinTeam,
    switchTeam,
    createInvite,
    setClaim,
    updateMemberRole,
    removeMember,
    transferOwnership,
    leaveTeam,
    sendPresence,
  };
}
