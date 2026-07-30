import { useState, useEffect, useCallback } from "react";

const TOKEN_KEY = "ai-ide-token";
const ISOLATED_TOKEN_KEY = "ai-ide-isolated-token";
const VIBE_WINDOW_HANDOFF = "crownforge-vibe-session";

function initialToken(): { token: string | null; isolated: boolean } {
  if (typeof window === "undefined") return { token: null, isolated: false };
  let isolatedToken = sessionStorage.getItem(ISOLATED_TOKEN_KEY);
  if (!isolatedToken && window.name) {
    try {
      const handoff = JSON.parse(window.name) as { type?: string; token?: string };
      if (handoff.type === VIBE_WINDOW_HANDOFF && typeof handoff.token === "string") {
        isolatedToken = handoff.token;
        sessionStorage.setItem(ISOLATED_TOKEN_KEY, isolatedToken);
        window.name = "";
      }
    } catch {
      // A regular named browser window is not an authentication handoff.
    }
  }
  return isolatedToken
    ? { token: isolatedToken, isolated: true }
    : { token: localStorage.getItem(TOKEN_KEY), isolated: false };
}

const initialAuth = initialToken();

interface AuthUser {
  username: string;
  workspaceDir: string;
  isAdmin: boolean;
  isolated: boolean;
}

export function useAuth() {
  const [token, setToken] = useState<string | null>(initialAuth.token);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Validate stored token on mount
  useEffect(() => {
    const stored = token;
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
        setUser({
          username: data.username,
          workspaceDir: data.workspaceDir,
          isAdmin: Boolean(data.isAdmin),
          isolated: Boolean(data.isolated),
        });
      })
      .catch(() => {
        if (sessionStorage.getItem(ISOLATED_TOKEN_KEY) === stored) sessionStorage.removeItem(ISOLATED_TOKEN_KEY);
        else localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [token]);

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
      sessionStorage.removeItem(ISOLATED_TOKEN_KEY);
      setToken(data.token);
      setUser({
        username: data.username,
        workspaceDir: data.workspaceDir,
        isAdmin: Boolean(data.isAdmin),
        isolated: false,
      });
      return null; // no error
    } catch {
      return "Network error";
    }
  }, []);

  const register = useCallback(async (
    username: string,
    password: string
  ): Promise<string | null> => {
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return data.error || "Registration failed";
      }
      return null;
    } catch {
      return "Network error";
    }
  }, []);

  const logout = useCallback(() => {
    const stored = token;
    if (stored) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${stored}` },
      }).catch(() => {});
    }
    if (stored && sessionStorage.getItem(ISOLATED_TOKEN_KEY) === stored) {
      sessionStorage.removeItem(ISOLATED_TOKEN_KEY);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
    setToken(null);
    setUser(null);
  }, [token]);

  const changeWorkspace = useCallback(async (path: string): Promise<boolean> => {
    if (!token) return false;
    if (user?.isolated) return false;
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
  }, [token, user?.isolated]);

  return { token, user, loading, login, register, logout, changeWorkspace };
}
