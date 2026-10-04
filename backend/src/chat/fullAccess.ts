import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSamePath, sessionManager, type SessionManager, type UserSession } from "../auth/sessionManager.js";
import { PolicyAuditLog } from "../agent/policyAudit.js";
import { isValidConversationId } from "./history.js";
import { canWriteActiveWorkspace, resolveActiveTeam } from "../team/sessionBridge.js";
import { subscribeTeamAccessChanges } from "../team/teamManager.js";

export type ApprovalMode = "ask" | "full_access";
export interface FullAccessGrant { grantId: string; revision: number }
export interface ApprovalModeState {
  mode: ApprovalMode;
  workspaceDir: string;
  conversationId: string;
  revision: number;
  canEnable: boolean;
}
export interface ApprovalModeUpdate {
  mode: ApprovalMode;
  expectedRevision: number;
  acknowledgeRisk?: boolean;
}
interface Scope {
  namespace: string;
  session: UserSession;
  workspaceDir: string;
  conversationId: string;
  canEnable: boolean;
}
interface ModeRecord {
  scope: Scope;
  mode: ApprovalMode;
  revision: number;
  grantId?: string;
  teamId: string | null;
}
export interface ApprovalModeChange {
  /** Internal authorization namespace; never returned to the browser or audit. */
  namespace: string;
  workspaceDir: string;
  conversationId: string;
  mode: ApprovalMode;
  revision: number;
}
const listeners = new Set<(change: ApprovalModeChange) => void>();
export function subscribeApprovalModeChanges(listener: (change: ApprovalModeChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export class ApprovalModeError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409 | 429 | 500, message: string, readonly state?: ApprovalModeState) { super(message); }
}

function canonicalWorkspace(workspace: string): string {
  return fs.realpathSync.native(workspace);
}
function scopeKey(scope: Pick<Scope, "namespace" | "workspaceDir" | "conversationId">): string {
  const workspaceKey = process.platform === "win32" ? scope.workspaceDir.toLowerCase() : scope.workspaceDir;
  return `${scope.namespace}\0${workspaceKey}\0${scope.conversationId}`;
}

/** Ephemeral, server-owned grants. Restart and login expiry restore ask mode. */
export class FullAccessService {
  private readonly records = new Map<string, ModeRecord>();
  private readonly unsubscribe: Array<() => void>;
  constructor(private readonly manager: SessionManager) {
    this.unsubscribe = [
      manager.onSessionRevoked((token) => {
        for (const [key, record] of this.records) {
          if (record.scope.namespace !== token) continue;
          this.revoke(record, "Authenticated login ended");
          this.records.delete(key);
        }
      }),
      manager.onWorkspaceChanged((token, previousWorkspace) => {
        const live = manager.getSession(token, { touch: false });
        const namespace = live && manager.getVerifiedSessionNamespace(live);
        if (!namespace) return;
        for (const record of this.records.values()) {
          if (record.scope.namespace === namespace && isSamePath(record.scope.workspaceDir, previousWorkspace)) {
            this.revoke(record, "User switched the authorized workspace");
          }
        }
      }),
      subscribeTeamAccessChanges((change) => {
        if (change.role !== "viewer" && change.role !== null) return;
        for (const record of this.records.values()) {
          if (record.teamId === change.teamId && record.scope.session.username === change.username) {
            this.revoke(record, "Workspace write permission was revoked");
          }
        }
      }),
    ];
  }
  dispose(): void { this.unsubscribe.forEach((unsubscribe) => unsubscribe()); this.records.clear(); }

  private resolveScope(session: UserSession, conversationId: string): Scope {
    if (!isValidConversationId(conversationId)) throw new ApprovalModeError(400, "Invalid conversation id");
    const live = this.manager.getSession(session.token, { touch: false });
    if (!live || live.username !== session.username) throw new ApprovalModeError(401, "Authenticated session expired");
    const workspaceDir = canonicalWorkspace(live.workspaceDir);
    if (!isSamePath(workspaceDir, canonicalWorkspace(session.workspaceDir))) throw new ApprovalModeError(409, "Workspace changed; refresh before continuing");
    const namespace = this.manager.getVerifiedSessionNamespace(live);
    if (!namespace) throw new ApprovalModeError(401, "Authenticated session could not be verified");
    const canEnable = process.env.CREWFORGE_DESKTOP !== "1" && canWriteActiveWorkspace(live) && this.manager.getApprovalScopeToken(live) === namespace;
    return { namespace, session: live, workspaceDir, conversationId, canEnable };
  }
  private state(scope: Scope, record?: ModeRecord): ApprovalModeState {
    return { mode: record?.mode || "ask", workspaceDir: scope.workspaceDir, conversationId: scope.conversationId,
      revision: record?.revision || 0, canEnable: scope.canEnable };
  }
  private audit(record: ModeRecord, action: string, previousGrantId?: string): void {
    new PolicyAuditLog(path.join(record.scope.workspaceDir, ".crewforge", "policy-audit.jsonl")).append({
      runId: `approval-mode:${record.scope.conversationId}`, workspace: record.scope.workspaceDir,
      requestId: `approval-mode:${record.revision}`, toolCallId: record.grantId || previousGrantId || "approval-mode",
      toolName: "user_approval_mode", allowed: record.mode === "full_access", reason: action,
      input: { actor: record.scope.session.username, conversationId: record.scope.conversationId,
        mode: record.mode, revision: record.revision, ...(record.grantId || previousGrantId ? { grantId: record.grantId || previousGrantId } : {}),
        authorizationSource: "authenticated_user", scope: "login_workspace_conversation" },
    });
  }
  private notify(record: ModeRecord): void {
    const change: ApprovalModeChange = { namespace: record.scope.namespace, workspaceDir: record.scope.workspaceDir,
      conversationId: record.scope.conversationId, mode: record.mode, revision: record.revision };
    for (const listener of listeners) {
      try { listener(change); } catch { /* Observers cannot undo an authorization change. */ }
    }
  }
  private revoke(record: ModeRecord, reason: string): void {
    if (record.mode !== "full_access") return;
    const grantId = record.grantId;
    record.mode = "ask"; record.grantId = undefined; record.revision += 1;
    // Revocation is effective even if a broken audit chain rejects a new record.
    this.notify(record);
    try { this.audit(record, reason, grantId); } catch { /* Keep authorization fail-closed. */ }
  }
  getState(session: UserSession, conversationId: string): ApprovalModeState {
    const scope = this.resolveScope(session, conversationId);
    const record = this.records.get(scopeKey(scope));
    if (record && !scope.canEnable) this.revoke(record, "Full access is unavailable for this session or workspace");
    return this.state(scope, record);
  }
  update(session: UserSession, conversationId: string, update: ApprovalModeUpdate): ApprovalModeState {
    if (!update || (update.mode !== "ask" && update.mode !== "full_access") || !Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0) {
      throw new ApprovalModeError(400, "Invalid approval mode update");
    }
    const scope = this.resolveScope(session, conversationId);
    const current = this.records.get(scopeKey(scope));
    if (current && !scope.canEnable) this.revoke(current, "Full access is unavailable for this session or workspace");
    if (update.expectedRevision !== (current?.revision || 0)) throw new ApprovalModeError(409, "Approval mode changed; refresh before continuing", this.state(scope, current));
    if (update.mode === "full_access" && !scope.canEnable) throw new ApprovalModeError(403,
      process.env.CREWFORGE_DESKTOP === "1" ? "Full access is currently available only on the Web backend" : "Workspace is read-only");
    if (update.mode === "full_access" && update.acknowledgeRisk !== true) throw new ApprovalModeError(403, "Explicit risk acknowledgement is required");
    // Keep tombstones until login revocation so an old expectedRevision cannot
    // become valid again after eviction. Quotas follow the verified namespace;
    // one login cannot exhaust another tenant's approval scopes.
    if (!current) {
      let scopedRecords = 0;
      for (const record of this.records.values()) if (record.scope.namespace === scope.namespace) scopedRecords += 1;
      if (scopedRecords >= 512) throw new ApprovalModeError(429, "Too many approval scopes in this login; start a new login session");
    }
    const record: ModeRecord = { scope, mode: update.mode, revision: (current?.revision || 0) + 1,
      ...(update.mode === "full_access" ? { grantId: crypto.randomUUID() } : {}), teamId: resolveActiveTeam(scope.session)?.id || null };
    // Audit must succeed before elevating. A disable always takes effect first.
    if (record.mode === "full_access") this.audit(record, "User explicitly enabled full access");
    this.records.set(scopeKey(scope), record);
    this.notify(record);
    if (record.mode === "ask") {
      try { this.audit(record, "User disabled full access and restored per-tool approval", current?.grantId); } catch { /* Disabling never waits on auditing. */ }
    }
    return this.state(scope, record);
  }
  getGrant(session: UserSession, conversationId: string): FullAccessGrant | null {
    try {
      const state = this.getState(session, conversationId);
      if (!state.canEnable || state.mode !== "full_access") return null;
      const scope = this.resolveScope(session, conversationId);
      const record = this.records.get(scopeKey(scope));
      return record?.grantId ? { grantId: record.grantId, revision: record.revision } : null;
    } catch { return null; }
  }
}

const services = new WeakMap<SessionManager, FullAccessService>();
function service(): FullAccessService {
  let current = services.get(sessionManager);
  if (!current) { current = new FullAccessService(sessionManager); services.set(sessionManager, current); }
  return current;
}
export function getApprovalMode(session: UserSession, conversationId: string): ApprovalModeState { return service().getState(session, conversationId); }
export function updateApprovalMode(session: UserSession, conversationId: string, update: ApprovalModeUpdate): ApprovalModeState { return service().update(session, conversationId, update); }
export function getFullAccessGrant(session: UserSession, conversationId: string): FullAccessGrant | null { return service().getGrant(session, conversationId); }
