import { useCallback, useMemo } from "react";
import { AdminSettings, LlmSettings } from "../types";

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

  return useMemo(
    () => ({
      fetchSettings,
      createUser,
      updateUserPassword,
      deleteUser,
      updateLlmSettings,
    }),
    [
      fetchSettings,
      createUser,
      updateUserPassword,
      deleteUser,
      updateLlmSettings,
    ]
  );
}
