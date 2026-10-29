export const AUTH_TOKEN_KEY = "ai-ide-token";
export const ISOLATED_AUTH_TOKEN_KEY = "ai-ide-isolated-token";
export const WINDOW_WORKSPACE_KEY = "ai-ide-window-workspace";

export class AuthSessionError extends Error {
  constructor(public readonly kind: "unauthorized" | "unavailable", message: string) {
    super(message);
    this.name = "AuthSessionError";
  }
}

async function fetchAuth(fetcher: typeof fetch, url: string, init: RequestInit): Promise<{ response: Response; data: VerifiedAuthSession }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new AuthSessionError("unavailable", "Server unavailable"));
    }, 10_000);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { ...init, signal: controller.signal });
        // A proxy can deliver headers and then stall. Reading the body belongs
        // to the same deadline so the login screen can offer a fresh attempt.
        const data = response.ok ? await response.json() as VerifiedAuthSession : {} as VerifiedAuthSession;
        return { response, data };
      })(),
      deadline,
    ]);
  } catch {
    throw new AuthSessionError("unavailable", "Server unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function authResponseError(response: Response, message: string): AuthSessionError {
  return new AuthSessionError(response.status === 401 || response.status === 403 ? "unauthorized" : "unavailable", message);
}

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
  const request = (path?: string) => fetchAuth(fetcher, "/api/auth/session/window", {
    method: "POST",
    headers: { Authorization: `Bearer ${parentToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(path ? { path } : {}),
  });
  let result = await request(workspaceDir);
  // A deleted or no longer authorized saved folder falls back to the login root.
  if (result.response.status === 403 && workspaceDir) result = await request();
  if (!result.response.ok) throw authResponseError(result.response, "Failed to open window session");
  const data = result.data;
  if (!data.token || data.token === parentToken || data.username !== parent.username || data.isolated
    || typeof data.workspaceDir !== "string") throw new Error("Invalid window session");
  return data;
}

export async function fetchCurrentAuthSession(
  token: string | null,
  isolated: boolean,
  fetcher: typeof fetch = fetch
): Promise<VerifiedAuthSession> {
  let result = await fetchAuth(fetcher, "/api/auth/me", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // A local desktop restart invalidates its old token. The server decides
  // whether an anonymous retry may open a desktop session. Isolated windows
  // must retain their scoped session and never fall back to the main window.
  if (result.response.status === 401 && token && !isolated) {
    result = await fetchAuth(fetcher, "/api/auth/me", { headers: {} });
  }
  if (!result.response.ok) throw authResponseError(result.response, "Invalid token");
  return result.data;
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
