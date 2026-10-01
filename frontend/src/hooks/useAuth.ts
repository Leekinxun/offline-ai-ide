import { useState, useEffect, useCallback, useRef } from "react";
import { AUTH_TOKEN_KEY, ISOLATED_AUTH_TOKEN_KEY, fetchCurrentAuthSession, persistVerifiedAuthToken, createWindowAuthSession, persistWindowWorkspace, WINDOW_WORKSPACE_KEY } from "./authSession";

const TOKEN_KEY = AUTH_TOKEN_KEY;
const ISOLATED_TOKEN_KEY = ISOLATED_AUTH_TOKEN_KEY;
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
// StrictMode mounts the effect twice; one browser document needs one session.
let initialSessionPromise: Promise<{ loginToken: string; data: Awaited<ReturnType<typeof fetchCurrentAuthSession>> }> | null = null;

function initializeSession() {
  if (!initialSessionPromise) {
    initialSessionPromise = (async () => {
      const parent = await fetchCurrentAuthSession(initialAuth.token, initialAuth.isolated);
      const loginToken = parent.token || initialAuth.token;
      if (!loginToken) throw new Error("Invalid token");
      const data = await createWindowAuthSession(parent, loginToken, sessionStorage);
      return { loginToken, data };
    })();
  }
  return initialSessionPromise;
}

interface AuthUser {
  username: string;
  workspaceDir: string;
  isAdmin: boolean;
  isolated: boolean;
  desktop: boolean;
}

export type DesktopFolderPickResult =
  | { status: "selected" | "cancelled" }
  | { status: "error"; message: string };

export function useAuth() {
  const [token, setToken] = useState<string | null>(initialAuth.token);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loginTokenRef = useRef<string | null>(initialAuth.token);
  const isolatedRef = useRef(initialAuth.isolated);
  const authVersionRef = useRef(0);

  // API tokens belong to this document; the shared login token stays unchanged.
  useEffect(() => {
    let cancelled = false;
    const version = authVersionRef.current;
    initializeSession().then(({ loginToken, data }) => {
      if (cancelled || version !== authVersionRef.current) return;
      persistVerifiedAuthToken(loginToken, initialAuth.token, initialAuth.isolated || data.isolated, localStorage, sessionStorage);
      if (!data.isolated) persistWindowWorkspace(data.username, data.workspaceDir, sessionStorage);
      loginTokenRef.current = loginToken;
      isolatedRef.current = Boolean(data.isolated);
      setToken(data.token || loginToken);
      setUser({
        username: data.username, workspaceDir: data.workspaceDir,
        isAdmin: Boolean(data.isAdmin), isolated: Boolean(data.isolated), desktop: Boolean(data.desktop),
      });
    }).catch(() => {
      if (cancelled || version !== authVersionRef.current) return;
      if (initialAuth.token) {
        if (sessionStorage.getItem(ISOLATED_TOKEN_KEY) === initialAuth.token) sessionStorage.removeItem(ISOLATED_TOKEN_KEY);
        else if (localStorage.getItem(TOKEN_KEY) === initialAuth.token) localStorage.removeItem(TOKEN_KEY);
      }
      loginTokenRef.current = null;
      setToken(null);
      setUser(null);
    }).finally(() => {
      if (!cancelled && version === authVersionRef.current) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<string | null> => {
    const version = ++authVersionRef.current;
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
      const parent = await res.json();
      sessionStorage.removeItem(WINDOW_WORKSPACE_KEY);
      const data = await createWindowAuthSession(parent, parent.token, sessionStorage);
      if (version !== authVersionRef.current) return "Login cancelled";
      loginTokenRef.current = parent.token;
      isolatedRef.current = false;
      localStorage.setItem(TOKEN_KEY, parent.token);
      persistWindowWorkspace(data.username, data.workspaceDir, sessionStorage);
      sessionStorage.removeItem(ISOLATED_TOKEN_KEY);
      setLoading(false);
      setToken(data.token || null);
      setUser({
        username: data.username,
        workspaceDir: data.workspaceDir,
        isAdmin: Boolean(data.isAdmin),
        isolated: false,
        desktop: Boolean(data.desktop),
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
    authVersionRef.current += 1;
    const stored = loginTokenRef.current;
    if (stored) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${stored}` },
      }).catch(() => {});
    }
    if (isolatedRef.current) {
      sessionStorage.removeItem(ISOLATED_TOKEN_KEY);
    } else {
      if (localStorage.getItem(TOKEN_KEY) === stored) localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(WINDOW_WORKSPACE_KEY);
    }
    loginTokenRef.current = null;
    setLoading(false);
    setToken(null);
    setUser(null);
  }, []);

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
      setUser((prev) => {
        if (prev) persistWindowWorkspace(prev.username, data.workspaceDir, sessionStorage);
        return prev ? { ...prev, workspaceDir: data.workspaceDir } : null;
      });
      return true;
    } catch {
      return false;
    }
  }, [token, user?.isolated]);

  const pickDesktopWorkspace = useCallback(async (): Promise<DesktopFolderPickResult> => {
    if (!token || !user?.desktop || user.isolated) {
      return { status: "error", message: "Folder selection is unavailable" };
    }
    try {
      const res = await fetch("/api/auth/workspace/pick", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        return { status: "error", message: data.error || "Failed to open folder" };
      }
      if (data.cancelled) return { status: "cancelled" };
      if (typeof data.workspaceDir !== "string") {
        return { status: "error", message: "Invalid folder selection response" };
      }
      setUser((previous) => {
        if (previous) persistWindowWorkspace(previous.username, data.workspaceDir, sessionStorage);
        return previous ? { ...previous, workspaceDir: data.workspaceDir } : null;
      });
      return { status: "selected" };
    } catch {
      return { status: "error", message: "Failed to open folder" };
    }
  }, [token, user?.desktop, user?.isolated]);

  return { token, user, loading, login, register, logout, changeWorkspace, pickDesktopWorkspace };
}
