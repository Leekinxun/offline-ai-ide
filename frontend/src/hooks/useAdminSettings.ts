import { useCallback, useMemo } from "react";
import {
  AdminSettings,
  AppSettings,
  LlmSettings,
  McpSettings,
  McpServerPreview,
  ModelCapabilities,
  MemoryEntry,
  MemoryScope,
  SkillDetail,
  SkillSummary,
  SkillUsageRecord,
} from "../types";

const API = "/api/admin";

export function useAdminSettings(token: string) {
  const authHeaders = useCallback(
    (extra?: Record<string, string>): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      ...extra,
    }),
    [token]
  );

  const fetchSettings = useCallback(async (): Promise<AdminSettings> => {
    const res = await fetch(`${API}/settings`, { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to load settings");
    }
    return res.json();
  }, [authHeaders]);

  const createUser = useCallback(
    async (payload: {
      username: string;
      password: string;
      defaultWorkspace: string;
      isAdmin: boolean;
    }) => {
      const res = await fetch(`${API}/users`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create user");
      }
      return res.json();
    },
    [authHeaders]
  );

  const updateUserPassword = useCallback(
    async (username: string, password: string) => {
      const res = await fetch(
        `${API}/users/${encodeURIComponent(username)}/password`,
        {
          method: "PATCH",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ password }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update password");
      }
      return res.json();
    },
    [authHeaders]
  );

  const deleteUser = useCallback(
    async (username: string) => {
      const res = await fetch(`${API}/users/${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete user");
      }
      return res.json();
    },
    [authHeaders]
  );

  const updateLlmSettings = useCallback(
    async (settings: LlmSettings) => {
      const res = await fetch(`${API}/llm`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save LLM settings");
      }
      const data = await res.json();
      return data.llm as LlmSettings;
    },
    [authHeaders]
  );

  const fetchLlmCapabilities = useCallback(
    async (refresh = false): Promise<ModelCapabilities> => {
      const res = await fetch(`${API}/llm/capabilities${refresh ? "?refresh=1" : ""}`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to detect model capabilities");
      }
      const data = await res.json();
      return data.capabilities as ModelCapabilities;
    },
    [authHeaders]
  );

  const updateAppSettings = useCallback(
    async (settings: AppSettings) => {
      const res = await fetch(`${API}/app`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save app settings");
      }
      const data = await res.json();
      return data.app as AppSettings;
    },
    [authHeaders]
  );

  const updateMcpSettings = useCallback(
    async (settings: McpSettings) => {
      const res = await fetch(`${API}/mcp`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save MCP settings");
      }
      const data = await res.json();
      return data.mcp as McpSettings;
    },
    [authHeaders]
  );

  const inspectMcpServers = useCallback(async (): Promise<McpServerPreview[]> => {
    const res = await fetch(`${API}/mcp/inspect`, { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to inspect MCP servers");
    }
    const data = await res.json();
    return Array.isArray(data.servers) ? (data.servers as McpServerPreview[]) : [];
  }, [authHeaders]);

  const fetchMemory = useCallback(async (): Promise<MemoryEntry[]> => {
    const res = await fetch(`${API}/memory`, { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to load memory");
    }
    const data = await res.json();
    return Array.isArray(data.memory) ? (data.memory as MemoryEntry[]) : [];
  }, [authHeaders]);

  const updateMemory = useCallback(async (scope: MemoryScope, content: string): Promise<MemoryEntry[]> => {
    const res = await fetch(`${API}/memory/${scope}`, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to save memory");
    }
    const data = await res.json();
    return data.memory as MemoryEntry[];
  }, [authHeaders]);

  const deleteMemory = useCallback(async (scope: MemoryScope): Promise<MemoryEntry[]> => {
    const res = await fetch(`${API}/memory/${scope}`, { method: "DELETE", headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to clear memory");
    }
    const data = await res.json();
    return data.memory as MemoryEntry[];
  }, [authHeaders]);

  const mergeMemory = useCallback(async (sourceScope: MemoryScope, targetScope: MemoryScope): Promise<MemoryEntry[]> => {
    const res = await fetch(`${API}/memory/merge`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sourceScope, targetScope }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to merge memory");
    }
    const data = await res.json();
    return data.memory as MemoryEntry[];
  }, [authHeaders]);

  const fetchSkills = useCallback(async (query = ""): Promise<SkillSummary[]> => {
    const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    const res = await fetch(`${API}/skills${params}`, { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to load skills");
    }
    const data = await res.json();
    return Array.isArray(data.skills) ? (data.skills as SkillSummary[]) : [];
  }, [authHeaders]);

  const fetchSkill = useCallback(async (name: string): Promise<SkillDetail> => {
    const res = await fetch(`${API}/skills/${encodeURIComponent(name)}`, { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to load skill");
    }
    const data = await res.json();
    return data.skill as SkillDetail;
  }, [authHeaders]);

  const setSkillEnabled = useCallback(async (name: string, enabled: boolean): Promise<SkillSummary> => {
    const res = await fetch(`${API}/skills/${encodeURIComponent(name)}/enabled`, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to update skill");
    }
    const data = await res.json();
    return data.skill as SkillSummary;
  }, [authHeaders]);

  const fetchSkillUsage = useCallback(async (name: string): Promise<SkillUsageRecord[]> => {
    const res = await fetch(`${API}/skills/${encodeURIComponent(name)}/usage`, { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to load skill usage");
    }
    const data = await res.json();
    return Array.isArray(data.usage) ? (data.usage as SkillUsageRecord[]) : [];
  }, [authHeaders]);

  return useMemo(
    () => ({
      fetchSettings,
      createUser,
      updateUserPassword,
      deleteUser,
      updateLlmSettings,
      fetchLlmCapabilities,
      updateAppSettings,
      updateMcpSettings,
      inspectMcpServers,
      fetchMemory,
      updateMemory,
      deleteMemory,
      mergeMemory,
      fetchSkills,
      fetchSkill,
      setSkillEnabled,
      fetchSkillUsage,
    }),
    [
      fetchSettings,
      createUser,
      updateUserPassword,
      deleteUser,
      updateLlmSettings,
      fetchLlmCapabilities,
      updateAppSettings,
      updateMcpSettings,
      inspectMcpServers,
      fetchMemory,
      updateMemory,
      deleteMemory,
      mergeMemory,
      fetchSkills,
      fetchSkill,
      setSkillEnabled,
      fetchSkillUsage,
    ]
  );
}
