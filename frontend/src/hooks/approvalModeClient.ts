export type ApprovalMode = "ask" | "full_access";

export interface ApprovalModeScope {
  token: string;
  workspaceDir: string;
  conversationId: string | null;
}

export interface ApprovalModeSnapshot {
  mode: ApprovalMode;
  workspaceDir: string;
  conversationId: string;
  revision: number;
  canEnable: boolean;
}

export interface ApprovalModeState {
  snapshot: ApprovalModeSnapshot | null;
  verified: boolean;
  loading: boolean;
  busy: boolean;
  error: "load" | "update" | "conflict" | null;
}

const initialState = (): ApprovalModeState => ({ snapshot: null, verified: false, loading: false, busy: false, error: null });

export function parseApprovalModeSnapshot(body: unknown, scope: ApprovalModeScope): ApprovalModeSnapshot {
  if (!body || typeof body !== "object") throw new Error("Invalid approval mode response");
  const value = body as Partial<ApprovalModeSnapshot>;
  if ((value.mode !== "ask" && value.mode !== "full_access")
    || value.conversationId !== scope.conversationId
    || value.workspaceDir !== scope.workspaceDir
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.canEnable !== "boolean") throw new Error("Invalid approval mode scope");
  return value as ApprovalModeSnapshot;
}

// All transitions use authenticated server acknowledgements. This client never
// changes the approval queue or sends authorization through the model transport.
export class ApprovalModeClient {
  private state = initialState();
  private listeners = new Set<() => void>();
  private requestEpoch = 0;
  private active = true;
  private reader: AbortController | null = null;
  private writer: AbortController | null = null;
  private request: typeof fetch;

  constructor(readonly scope: ApprovalModeScope, request?: typeof fetch) {
    this.request = request ?? globalThis.fetch.bind(globalThis);
  }

  getSnapshot = (): ApprovalModeState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(next: Partial<ApprovalModeState>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }

  private get available() {
    return Boolean(this.scope.token && this.scope.workspaceDir && this.scope.conversationId);
  }

  private get url() {
    return `/api/chat/conversations/${encodeURIComponent(this.scope.conversationId || "")}/approval-mode`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.scope.token}`, "Content-Type": "application/json", "X-Workspace-Dir": encodeURIComponent(this.scope.workspaceDir) };
  }

  // React strict effects can stop and restart this same scope instance.
  activate() { this.active = true; }
  dispose() {
    this.active = false;
    this.requestEpoch += 1;
    this.reader?.abort();
    this.writer?.abort();
  }

  refresh = (): Promise<boolean> => this.load(false, false);

  private async load(duringUpdate: boolean, preserveError: boolean): Promise<boolean> {
    if (!this.active || !this.available || (this.state.busy && !duringUpdate)) return false;
    this.reader?.abort();
    const controller = new AbortController();
    this.reader = controller;
    const epoch = ++this.requestEpoch;
    this.publish({ loading: true });
    try {
      const response = await this.request(this.url, { headers: this.headers(), signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Could not read approval mode");
      const snapshot = parseApprovalModeSnapshot(await response.json(), this.scope);
      if (!this.active || epoch !== this.requestEpoch || controller.signal.aborted) return false;
      this.publish({ snapshot, verified: true, ...(preserveError ? {} : { error: null }) });
      return true;
    } catch {
      if (this.active && epoch === this.requestEpoch && !controller.signal.aborted) {
        this.publish({ verified: false, ...(preserveError ? {} : { error: "load" }) });
      }
      return false;
    } finally {
      if (this.active && epoch === this.requestEpoch && !controller.signal.aborted) this.publish({ loading: false });
    }
  }

  setMode = async (mode: ApprovalMode, acknowledgeRisk = false): Promise<boolean> => {
    const previous = this.state.snapshot;
    if (!this.active || !this.available || !this.state.verified || !previous || this.state.busy
      || (mode === "full_access" && (!previous.canEnable || !acknowledgeRisk))) return false;
    if (mode === previous.mode) return true;
    this.reader?.abort();
    const epoch = ++this.requestEpoch;
    const controller = new AbortController();
    this.writer = controller;
    this.publish({ busy: true, loading: false, error: null });
    let failure: "update" | "conflict" = "update";
    try {
      const response = await this.request(this.url, {
        method: "PUT", headers: this.headers(), signal: controller.signal, cache: "no-store",
        body: JSON.stringify({ mode, expectedRevision: previous.revision, ...(mode === "full_access" ? { acknowledgeRisk: true } : {}) }),
      });
      if (response.status === 409) failure = "conflict";
      if (!response.ok) throw new Error("Could not update approval mode");
      const snapshot = parseApprovalModeSnapshot(await response.json(), this.scope);
      if (snapshot.mode !== mode) throw new Error("Approval mode was not confirmed");
      if (!this.active || epoch !== this.requestEpoch || controller.signal.aborted) return false;
      this.publish({ snapshot, verified: true });
      return true;
    } catch {
      if (this.active && epoch === this.requestEpoch && !controller.signal.aborted) {
        // A lost response may have followed a successful write. Re-read before
        // making any claim that permissions were enabled or revoked.
        this.publish({ verified: false, error: failure });
        await this.load(true, true);
      }
      return false;
    } finally {
      if (this.active && !controller.signal.aborted) this.publish({ busy: false });
      if (this.writer === controller) this.writer = null;
    }
  };
}
