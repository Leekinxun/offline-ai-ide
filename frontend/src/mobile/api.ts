export type PairingStatus =
  | "pending"
  | "claimed"
  | "approved"
  | "rejected"
  | "expired"
  | "used";

export interface PairingTicket {
  id: string;
  ticket?: string;
  pairUrl?: string;
  shortCode?: string;
  expiresAt: number;
  status: PairingStatus;
  deviceName?: string;
  claimedAt?: number | null;
}

export interface PairingClaim {
  claimToken: string;
  shortCode: string;
  status: PairingStatus;
  expiresAt?: number;
}

export interface PairingClaimStatus {
  status: PairingStatus;
  shortCode?: string;
  expiresAt?: number;
}

export interface MobileDevice {
  id: string;
  deviceName?: string;
  createdAt?: number;
  lastSeenAt?: number;
  expiresAt?: number;
  current?: boolean;
  teamId?: string | null;
}

export interface MobileSession {
  id: string;
  username: string;
  teamId: string | null;
  scopeKey: string;
  expiresAt: number;
  idleExpiresAt: number;
  csrfToken: string;
  deviceName?: string;
}

export interface MobileScope {
  key: string;
  name: string;
  teamId: string | null;
  role: string;
}

export interface MobileWorkspace {
  id: string;
  name: string;
  role: string;
  canWrite: boolean;
  canControlAgents: boolean;
}

export interface MobileTask {
  id: string;
  workspaceId: string;
  title: string;
  preview: string;
  status: string;
  updatedAt: number;
  lastRunId?: string;
  runStatus?: string;
  mode: string;
  version: number;
}

export interface MobileApproval {
  id: string;
  taskId: string;
  runId: string;
  title: string;
  summary: string;
  risk: string;
  createdAt: number;
  canDecide: boolean;
}

export interface MobileRun {
  runId: string;
  conversationId: string;
  status: string;
  sequence: number;
  canControl: boolean;
  pendingApprovals?: MobileApproval[];
}

export interface MobileSnapshot {
  sequence: number;
  user: { username: string };
  workspace: MobileWorkspace;
  workspaces: MobileWorkspace[];
  tasks: MobileTask[];
  approvals: MobileApproval[];
  activeRuns: MobileRun[];
}

export interface MobileTaskDetail {
  task: MobileTask;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }>;
  runs: Array<{
    runId: string;
    status: string;
    updatedAt: number;
    mode: string;
    events: Array<{
      id: string;
      kind: string;
      label: string;
      timestamp: number;
      isError?: boolean;
    }>;
  }>;
  activeRun: MobileRun | null;
  changes: Array<{ path: string; operation?: string }>;
}

interface MobileRunCommand {
  commandId: string;
  action: "stop" | "steer" | "approve_once" | "deny";
  taskId: string;
  runId: string;
  approvalId?: string;
  message?: string;
  expectedVersion: number;
}

interface MobileStartCommand {
  commandId: string;
  action: "start";
  message: string;
  taskId?: string;
  mode?: "ask" | "plan" | "code" | "review";
  expectedVersion?: number;
}

export type MobileCommand = MobileRunCommand | MobileStartCommand;

export class MobileApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MobileApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new MobileApiError("网络连接中断，请检查网络后重试。", 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new MobileApiError(
      body?.error || body?.message || `请求失败 (${response.status})`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function desktopHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

export const mobileApi = {
  createPairing(token: string) {
    return request<PairingTicket>("/api/mobile/pairing", {
      method: "POST",
      headers: desktopHeaders(token),
    });
  },
  getPairing(token: string, id: string) {
    return request<PairingTicket>(
      `/api/mobile/pairing/${encodeURIComponent(id)}`,
      {
        headers: desktopHeaders(token),
      },
    );
  },
  approvePairing(token: string, id: string) {
    return request<PairingTicket>(
      `/api/mobile/pairing/${encodeURIComponent(id)}/approve`,
      {
        method: "POST",
        headers: desktopHeaders(token),
      },
    );
  },
  rejectPairing(token: string, id: string) {
    return request<PairingTicket>(
      `/api/mobile/pairing/${encodeURIComponent(id)}/reject`,
      {
        method: "POST",
        headers: desktopHeaders(token),
      },
    );
  },
  claimPairing(ticket: string) {
    return request<PairingClaim>("/api/mobile/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ ticket }),
    });
  },
  getClaimStatus(claimToken: string) {
    return request<PairingClaimStatus>("/api/mobile/pairing/claim/status", {
      method: "POST",
      body: JSON.stringify({ claimToken }),
    });
  },
  exchangeClaim(claimToken: string) {
    return request<{ session: MobileSession }>("/api/mobile/pairing/exchange", {
      method: "POST",
      body: JSON.stringify({ claimToken }),
    });
  },
  getMe() {
    return request<{ session: MobileSession }>("/api/mobile/pairing/me");
  },
  logout(csrfToken: string) {
    return request<void>("/api/mobile/pairing/logout", {
      method: "POST",
      headers: { "X-CrewForge-Mobile-CSRF": csrfToken },
    });
  },
  listDevices(token: string) {
    return request<{ devices: MobileDevice[] }>("/api/mobile/pairing/devices", {
      headers: desktopHeaders(token),
    });
  },
  revokeDevice(token: string, id: string) {
    return request<void>(
      `/api/mobile/pairing/devices/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: desktopHeaders(token),
      },
    );
  },
  switchScope(key: string, csrfToken: string) {
    return request<{ session: MobileSession }>("/api/mobile/pairing/scope", {
      method: "POST",
      headers: { "X-CrewForge-Mobile-CSRF": csrfToken },
      body: JSON.stringify({ key }),
    });
  },
  getScopes() {
    return request<{ scopes: MobileScope[]; activeScopeKey: string }>(
      "/api/mobile/pairing/scopes",
    );
  },
  getSnapshot() {
    return request<MobileSnapshot>("/api/mobile/data/snapshot");
  },
  getTask(id: string) {
    return request<MobileTaskDetail>(
      `/api/mobile/data/tasks/${encodeURIComponent(id)}`,
    );
  },
  sendCommand(command: MobileCommand, csrfToken: string) {
    return request<{
      ok: boolean;
      commandId: string;
      result: string;
      conversationId?: string;
      runId?: string;
      created?: boolean;
    }>("/api/mobile/data/commands", {
      method: "POST",
      headers: { "X-CrewForge-Mobile-CSRF": csrfToken },
      body: JSON.stringify(command),
    });
  },
};

export function formatWhen(value?: string | number): string {
  if (!value) return "—";
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(timestamp)
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(timestamp);
}

export function formatEventTime(value?: number): string {
  if (!value) return "—";
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
