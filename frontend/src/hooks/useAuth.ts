import { useState, useEffect, useCallback } from "react";

const TOKEN_KEY = "ai-ide-token";

interface AuthUser {
  username: string;
  workspaceDir: string;
}

export function useAuth() {
  const [token, setToken] = useState<string | null>(localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Validate stored token on mount
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) {
      setLoading(false);
      return;
    }
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${stored}` } })
      .then((res) => {
        if (!res.ok) throw new Error("Invalid token");
        return res.json();
      })
      .then((data) => {
        setToken(stored);
        setUser({ username: data.username, workspaceDir: data.workspaceDir });
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return data.error || "Login failed";
      }
      const data = await res.json();
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setUser({ username: data.username, workspaceDir: data.workspaceDir });
      return null; // no error
    } catch {
      return "Network error";
    }
  }, []);

  const logout = useCallback(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${stored}` },
      }).catch(() => {});
    }
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const changeWorkspace = useCallback(async (path: string): Promise<boolean> => {
    if (!token) return false;
    try {
      const res = await fetch("/api/auth/workspace/change", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      setUser((prev) => prev ? { ...prev, workspaceDir: data.workspaceDir } : null);
      return true;
    } catch {
      return false;
    }
  }, [token]);

  return { token, user, loading, login, logout, changeWorkspace };
}
