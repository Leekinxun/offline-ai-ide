export const AUTH_TOKEN_KEY = "ai-ide-token";
export const ISOLATED_AUTH_TOKEN_KEY = "ai-ide-isolated-token";
export const WINDOW_WORKSPACE_KEY = "ai-ide-window-workspace";

interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface VerifiedAuthSession {
  username: string;
  workspaceDir: string;
  isAdmin: boolean;
  isolated: boolean;
  desktop: boolean;
  token?: string;
}

export function persistWindowWorkspace(username: string, workspaceDir: string, session: TokenStorage): void {
  session.setItem(WINDOW_WORKSPACE_KEY, JSON.stringify({ username, workspaceDir }));
}

/** Never persist the API token: copied tabs and reloads receive fresh sessions. */
export async function createWindowAuthSession(
  parent: VerifiedAuthSession,
  parentToken: string,
  session: TokenStorage,
  fetcher: typeof fetch = fetch
): Promise<VerifiedAuthSession> {
  if (parent.isolated) return parent;
  let workspaceDir: string | undefined;
  try {
    const saved = JSON.parse(session.getItem(WINDOW_WORKSPACE_KEY) || "null");
    if (saved?.username === parent.username && typeof saved.workspaceDir === "string" && saved.workspaceDir.trim()) {
      workspaceDir = saved.workspaceDir;
    }
  } catch { /* A damaged directory hint must not prevent authentication. */ }
  const request = (path?: string) => fetcher("/api/auth/session/window", {
    method: "POST",
    headers: { Authorization: `Bearer ${parentToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(path ? { path } : {}),
  });
  let response = await request(workspaceDir);
  // A deleted or no longer authorized saved folder falls back to the login root.
  if (response.status === 403 && workspaceDir) response = await request();
  if (!response.ok) throw new Error("Failed to open window session");
  const data = await response.json() as VerifiedAuthSession;
  if (!data.token || data.token === parentToken || data.username !== parent.username || data.isolated
    || typeof data.workspaceDir !== "string") throw new Error("Invalid window session");
  return data;
}

export async function fetchCurrentAuthSession(
  token: string | null,
  isolated: boolean,
  fetcher: typeof fetch = fetch
): Promise<VerifiedAuthSession> {
  let response = await fetcher("/api/auth/me", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // A local desktop restart invalidates its old token. The server decides
  // whether an anonymous retry may open a desktop session. Isolated windows
  // must retain their scoped session and never fall back to the main window.
  if (response.status === 401 && token && !isolated) {
    response = await fetcher("/api/auth/me", { headers: {} });
  }
  if (!response.ok) throw new Error("Invalid token");
  return response.json();
}

export function persistVerifiedAuthToken(
  token: string,
  previousToken: string | null,
  isolated: boolean,
  local: TokenStorage,
  session: TokenStorage
): void {
  const windowScoped = isolated || Boolean(previousToken && session.getItem(ISOLATED_AUTH_TOKEN_KEY) === previousToken);
  (windowScoped ? session : local).setItem(windowScoped ? ISOLATED_AUTH_TOKEN_KEY : AUTH_TOKEN_KEY, token);
}
