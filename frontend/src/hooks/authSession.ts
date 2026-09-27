export const AUTH_TOKEN_KEY = "ai-ide-token";
export const ISOLATED_AUTH_TOKEN_KEY = "ai-ide-isolated-token";

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
