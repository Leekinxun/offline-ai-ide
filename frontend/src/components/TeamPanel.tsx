import React, { useMemo, useState } from "react";
import { CollaborationMergeChoice, CollaborationMergePreview, CollaborationState, CollaborationSubject, TeamDetails, TeamRole, TeamSummary } from "../types";
import { useI18n } from "../i18n";
import { Copy, Plus, Users } from "lucide-react";
import { PanelHeader, PanelState } from "./PanelChrome";
import { TaskStateStrip } from "./TaskStateStrip";
import { ActionConfirmDialog, type ActionConfirmIntent } from "./ActionConfirmDialog";
import { useModalDialogFocus } from "./useModalDialogFocus";

interface TeamPanelProps {
  teams: TeamSummary[];
  activeTeam: TeamDetails | null;
  currentUsername: string;
  connected: boolean;
  loading: boolean;
  error: string | null;
  activeFilePath: string | null;
  drawerMode?: boolean;
  onClose?: () => void;
  onRefresh: () => void;
  onCreateTeam: (name: string) => Promise<void>;
  onJoinTeam: (code: string) => Promise<void>;
  onSwitchTeam: (teamId: string) => Promise<void>;
  onCreateInvite: (teamId: string, role: TeamRole) => Promise<string>;
  onUpdateMemberRole: (username: string, role: TeamRole) => Promise<void>;
  onTransferOwnership: (username: string) => Promise<void>;
  onRemoveMember: (username: string) => Promise<void>;
  onLeaveTeam: () => Promise<void>;
  onToggleClaim: (path: string, claimed: boolean) => Promise<void>;
  collaboration: CollaborationState | null;
  onAddComment: (input: { body: string; path: string; startLine?: number; endLine?: number; evidenceLinks?: string[] }) => Promise<unknown>;
  onCreateReview: (input: { assignees: CollaborationSubject[]; path: string; startLine?: number; endLine?: number; message?: string }) => Promise<unknown>;
  onCreateMergePreview: (changeSetId: string, path: string) => Promise<CollaborationMergePreview>;
  onDecideMerge: (preview: CollaborationMergePreview, choice: CollaborationMergeChoice, reason?: string, resolvedDigest?: string, supersedesDecisionId?: string) => Promise<unknown>;
}

export const TeamPanel: React.FC<TeamPanelProps> = ({
  teams,
  activeTeam,
  currentUsername,
  connected,
  loading,
  error,
  activeFilePath,
  drawerMode = false,
  onClose,
  onRefresh,
  onCreateTeam,
  onJoinTeam,
  onSwitchTeam,
  onCreateInvite,
  onUpdateMemberRole,
  onTransferOwnership,
  onRemoveMember,
  onLeaveTeam,
  onToggleClaim,
  collaboration,
  onAddComment,
  onCreateReview,
  onCreateMergePreview,
  onDecideMerge,
}) => {
  const { t } = useI18n();
  const [teamName, setTeamName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [lastInvite, setLastInvite] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<null | { kind: "leave" } | { kind: "remove" | "transfer"; username: string }>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const panelRef = useModalDialogFocus<HTMLDivElement>({ open: drawerMode, onClose: onClose || (() => undefined), suspended: Boolean(confirmation) });

  const activeClaim = useMemo(
    () => activeTeam?.claims.find((claim) => claim.path === activeFilePath) || null,
    [activeTeam, activeFilePath]
  );
  const canManageTeam = activeTeam?.role === "owner" || activeTeam?.role === "admin";
  const canClaimFile = activeTeam?.role !== "viewer";
  const currentRole = activeTeam?.role || null;
  const visibleError = !activeTeam && error?.trim().toLowerCase() === "no active team" ? null : error;
  const inviteRoleOptions: TeamRole[] =
    currentRole === "owner" ? ["member", "viewer", "admin"] : ["member", "viewer"];

  const canManageMember = (memberUsername: string, memberRole: TeamRole) => {
    if (!activeTeam) return false;
    if (memberUsername === currentUsername) return false;
    if (currentRole === "owner") return true;
    if (currentRole === "admin") {
      return memberRole === "member" || memberRole === "viewer";
    }
    return false;
  };

  const getAssignableRoles = (memberRole: TeamRole): TeamRole[] => {
    if (currentRole === "owner") {
      return ["owner", "admin", "member", "viewer"];
    }
    if (currentRole === "admin" && (memberRole === "member" || memberRole === "viewer")) {
      return ["member", "viewer"];
    }
    return [memberRole];
  };

  const handleCreate = async () => {
    if (!teamName.trim() || creating) return;
    setCreating(true);
    setActionError(null);
    try {
      await onCreateTeam(teamName.trim());
      setTeamName("");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : t("team.operationFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    if (!inviteCode.trim() || joining) return;
    setJoining(true);
    setActionError(null);
    try {
      await onJoinTeam(inviteCode.trim());
      setInviteCode("");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : t("team.operationFailed"));
    } finally {
      setJoining(false);
    }
  };

  const handleInvite = async () => {
    if (!activeTeam || inviteBusy) return;
    setInviteBusy(true);
    setActionError(null);
    try {
      const code = await onCreateInvite(activeTeam.id, inviteRole);
      setLastInvite(code);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : t("team.operationFailed"));
    } finally {
      setInviteBusy(false);
    }
  };

  const confirmationIntent: ActionConfirmIntent | null = confirmation ? {
    id: confirmation.kind === "leave" ? "team:leave" : `team:${confirmation.kind}:${confirmation.username}`,
    title: t("team.confirmAction"),
    description: confirmation.kind === "leave"
      ? t("team.leaveTeamConfirm", { name: activeTeam?.name || "" })
      : confirmation.kind === "remove"
        ? t("team.removeMemberConfirm", { username: confirmation.username })
        : t("team.transferOwnerConfirm", { username: confirmation.username }),
    confirmLabel: t("common.confirm"),
    tone: confirmation.kind === "transfer" ? "primary" : "danger",
  } : null;

  const executeConfirmation = async () => {
    const action = confirmation;
    if (!action) return;
    setConfirmationBusy(true);
    setActionError(null);
    try {
      if (action.kind === "leave") await onLeaveTeam();
      else if (action.kind === "remove") await onRemoveMember(action.username);
      else await onTransferOwnership(action.username);
      setConfirmation(null);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : t("team.operationFailed"));
    } finally {
      setConfirmationBusy(false);
    }
  };

  const teamEvidenceCount = (activeTeam?.activity.length || 0)
    + (collaboration?.comments.length || 0)
    + (collaboration?.reviewRequests.length || 0)
    + (collaboration?.mergeDecisions.length || 0);

  return (
    <div
      ref={panelRef}
      className="team-panel panel-shell workspace-drawer"
      role={drawerMode ? "dialog" : "complementary"}
      aria-modal={drawerMode || undefined}
      inert={confirmation ? true : undefined}
      aria-hidden={Boolean(confirmation) || undefined}
      aria-labelledby="team-panel-title"
      tabIndex={-1}
      data-workspace-drawer="team"
    >
      <PanelHeader
        titleId="team-panel-title"
        icon={<Users size={15} />}
        title={t("team.title")}
        status={connected ? t("team.connected") : t("team.disconnected")}
        statusTone={connected ? "success" : "warning"}
        refreshing={loading}
        refreshLabel={t("team.refresh")}
        closeLabel={t("common.close")}
        onRefresh={onRefresh}
        onClose={onClose}
      />

      <div className="collaboration-summary" aria-live="polite">
        <span><strong>{activeTeam?.onlineCount || 0}</strong>{t("team.onlineSummary")}</span>
        <span><strong>{activeTeam?.memberCount || 0}</strong>{t("team.memberSummary")}</span>
        <span className={currentRole === "viewer" ? "is-read-only" : ""}>
          <strong>{currentRole || "—"}</strong>{t("team.roleSummary")}
        </span>
      </div>

      <TaskStateStrip
        requested={activeTeam?.name || t("team.noActiveTeam")}
        running={connected ? t("team.connected") : t("team.disconnected")}
        runningTone={connected ? "success" : "warning"}
        evidence={teamEvidenceCount ? t("taskState.evidenceCount", { count: teamEvidenceCount }) : t("taskState.noEvidence")}
        evidenceTone={teamEvidenceCount ? "success" : "neutral"}
        action={t("team.refresh")}
        onAction={onRefresh}
        actionDisabled={loading}
        actionDisabledReason={loading ? t("common.loading") : undefined}
        compact
      />

      {visibleError && <PanelState tone="error" title={t("team.loadFailed")} detail={visibleError} actionLabel={t("team.refresh")} onAction={onRefresh} />}
      {actionError && <div className="delivery-inline-error" role="alert">{actionError}</div>}
      {loading && teams.length === 0 && !activeTeam && !visibleError && <PanelState tone="loading" title={t("team.loadingTitle")} detail={t("team.loadingHint")} />}

      <div className="team-panel-section">
        <label className="team-panel-label" htmlFor="team-switcher">{t("team.switcher")}</label>
        <select
          id="team-switcher"
          className="team-panel-select"
          value={activeTeam?.id || ""}
          onChange={(e) => {
            if (e.target.value) {
              void onSwitchTeam(e.target.value);
            }
          }}
        >
          <option value="">{t("team.noActiveTeam")}</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name} · {team.onlineCount}/{team.memberCount}
            </option>
          ))}
        </select>
      </div>

      {currentRole !== "viewer" && <div className="team-panel-section">
        <label className="team-panel-label" htmlFor="team-create-name">{t("team.create")}</label>
        <div className="team-panel-inline">
          <input
            id="team-create-name"
            className="dialog-input team-panel-input"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void handleCreate(); }}
            placeholder={t("team.teamNamePlaceholder")}
          />
          <button
            type="button"
            className="team-panel-btn primary"
            onClick={handleCreate}
            disabled={!teamName.trim() || creating}
            title={t("team.create")}
            aria-label={t("team.create")}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>}

      {currentRole !== "viewer" && <div className="team-panel-section">
        <label className="team-panel-label" htmlFor="team-invite-code">{t("team.joinByInvite")}</label>
        <div className="team-panel-inline">
          <input
            id="team-invite-code"
            className="dialog-input team-panel-input"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            onKeyDown={(event) => { if (event.key === "Enter") void handleJoin(); }}
            placeholder={t("team.inviteCodePlaceholder")}
          />
          <button
            type="button"
            className="team-panel-btn"
            onClick={handleJoin}
            disabled={!inviteCode.trim() || joining}
          >
            {t("team.join")}
          </button>
        </div>
      </div>}

      {!loading && !visibleError && !activeTeam && (
        <PanelState title={t("team.emptyTitle")} detail={t("team.emptyHint")} />
      )}

      {activeTeam && (
        <>
          <div className="team-panel-section">
            <div className="team-panel-label">{t("team.activeTeam")}</div>
            <div className="team-panel-card">
              <div className="team-panel-teamname">{activeTeam.name}</div>
              <div className="team-panel-meta">
                {activeTeam.role} · {activeTeam.onlineCount}/{activeTeam.memberCount}
              </div>
              <div className="team-panel-meta mono">{activeTeam.workspaceDir}</div>
              <div className="team-panel-inline team-panel-actions">
                {currentRole !== "viewer" && <button type="button" className="team-panel-btn danger" onClick={() => setConfirmation({ kind: "leave" })}>{t("team.leaveTeam")}</button>}
              </div>
            </div>
          </div>

          <div className="team-panel-section">
            <div className="team-panel-section-head">
              <div className="team-panel-label">{t("team.members")}</div>
              <div className="team-member-controls">
                <select
                  className="team-member-role-select"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as TeamRole)}
                  disabled={!canManageTeam}
                >
                  {inviteRoleOptions.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="team-panel-btn"
                  onClick={handleInvite}
                  disabled={inviteBusy || !canManageTeam}
                  title={!canManageTeam ? t("team.inviteRestricted") : undefined}
                >
                  <Copy size={13} aria-hidden="true" />
                  {t("team.createInvite")}
                </button>
              </div>
            </div>
            {!canManageTeam && (
              <div className="team-panel-hint">{t("team.inviteRestricted")}</div>
            )}
            {lastInvite && (
              <div className="team-panel-hint">
                {t("team.latestInvite")}: <code>{lastInvite}</code>
              </div>
            )}
            <div className="team-member-list">
              {activeTeam.presence.length === 0 && activeTeam.members.length === 0 ? (
                <div className="team-panel-empty">{t("team.emptyMembers")}</div>
              ) : (
                activeTeam.members.map((member) => {
                  const presence = activeTeam.presence.find(
                    (entry) => entry.username === member.username
                  );
                  const manageable = canManageMember(member.username, member.role);
                  const assignableRoles = getAssignableRoles(member.role);
                  const isSelf = member.username === currentUsername;
                  return (
                    <div key={member.username} className="team-member-row">
                      <div className="team-member-main team-member-main-wrap">
                        <div className="team-member-identity">
                          <span className={`team-dot${presence?.online ? " online" : ""}`} aria-hidden="true" />
                          <span className="sr-only">{presence?.online ? t("team.memberOnline") : t("team.memberOffline")}</span>
                          <span>{member.username}</span>
                          {isSelf && (
                            <span className="team-self-badge">{t("team.you")}</span>
                          )}
                          <span className="team-role-badge">{member.role}</span>
                        </div>
                        {manageable ? (
                          <div className="team-member-controls">
                            <select
                              className="team-member-role-select"
                              value={member.role}
                              onChange={(event) =>
                                void onUpdateMemberRole(
                                  member.username,
                                  event.target.value as TeamRole
                                )
                              }
                            >
                              {assignableRoles.map((role) => (
                                <option key={role} value={role}>
                                  {role}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="team-panel-btn danger"
                              onClick={() => setConfirmation({ kind: "remove", username: member.username })}
                            >
                              {t("team.removeMember")}
                            </button>
                            {currentRole === "owner" && member.role !== "owner" ? (
                              <button
                                type="button"
                                className="team-panel-btn"
                                onClick={() => setConfirmation({ kind: "transfer", username: member.username })}
                              >
                                {t("team.transferOwner")}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="team-member-side">
                        {presence?.activeFilePath && (
                          <span className="team-member-file">{presence.activeFilePath}</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {activeFilePath && (
            <div className="team-panel-section">
              <div className="team-panel-section-head">
                <div className="team-panel-label">{t("team.fileClaim")}</div>
                {canClaimFile && <button
                  type="button"
                  className="team-panel-btn"
                  onClick={() =>
                    void onToggleClaim(activeFilePath, activeClaim?.username ? false : true)
                  }
                >
                  {activeClaim?.username ? t("team.releaseClaim") : t("team.claimFile")}
                </button>}
              </div>
              <div className="team-panel-hint">
                {activeClaim
                  ? t("team.claimedBy", { username: activeClaim.username })
                  : t("team.unclaimed")}
              </div>
              {!canClaimFile && (
                <div className="team-panel-hint">{t("team.claimRestricted")}</div>
              )}
            </div>
          )}

          <div className="team-panel-section">
            <div className="team-panel-label">{t("team.activity")}</div>
            <div className="team-activity-list">
              {activeTeam.activity.length === 0 ? (
                <div className="team-panel-empty">{t("team.emptyActivity")}</div>
              ) : (
                activeTeam.activity.slice(0, 10).map((entry) => (
                  <div key={entry.id} className="team-activity-row">
                    <div className="team-activity-main">
                      <strong>{entry.username}</strong> {describeActivity(entry, t)}
                    </div>
                    <div className="team-activity-time">
                      {new Date(entry.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <CollaborationSection
            state={collaboration}
            activeFilePath={activeFilePath}
            readOnly={currentRole === "viewer"}
            members={activeTeam.members}
            onAddComment={onAddComment}
            onCreateReview={onCreateReview}
            onCreateMergePreview={onCreateMergePreview}
            onDecideMerge={onDecideMerge}
            onRefresh={onRefresh}
            onError={setActionError}
          />
        </>
      )}

      {loading && (teams.length > 0 || activeTeam) && <div className="team-panel-loading" role="status" aria-live="polite">{t("common.loading")}</div>}
      <ActionConfirmDialog
        intent={confirmationIntent}
        busy={confirmationBusy}
        error={actionError}
        onClose={() => setConfirmation(null)}
        onConfirm={() => executeConfirmation()}
      />
    </div>
  );
};

interface CollaborationSectionProps {
  state: CollaborationState | null;
  activeFilePath: string | null;
  readOnly: boolean;
  members: TeamDetails["members"];
  onAddComment: TeamPanelProps["onAddComment"];
  onCreateReview: TeamPanelProps["onCreateReview"];
  onCreateMergePreview: TeamPanelProps["onCreateMergePreview"];
  onDecideMerge: TeamPanelProps["onDecideMerge"];
  onRefresh: () => void;
  onError: (message: string | null) => void;
}

const CollaborationSection: React.FC<CollaborationSectionProps> = ({ state, activeFilePath, readOnly, members, onAddComment, onCreateReview, onCreateMergePreview, onDecideMerge, onRefresh, onError }) => {
  const { t } = useI18n();
  const [comment, setComment] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [busy, setBusy] = useState(false);
  const comments = state?.comments.filter((item) => !activeFilePath || item.anchor.path === activeFilePath).slice().reverse().slice(0, 12) || [];
  const reviews = state?.reviewRequests.filter((item) => !activeFilePath || item.anchor.path === activeFilePath).slice().reverse().slice(0, 8) || [];
  const buffers = state?.buffers.filter((item) => item.dirty && (!activeFilePath || item.path === activeFilePath)) || [];
  const ownership = state?.ownership?.claims.filter((item) => !activeFilePath || item.path === activeFilePath) || [];
  const changeSets = state?.ownership?.changeSets.filter((item) => !activeFilePath || item.paths.includes(activeFilePath)) || [];
  const previews = state?.mergePreviews.filter((item) => !activeFilePath || item.path === activeFilePath).slice().reverse() || [];
  const invoke = async (operation: () => Promise<unknown>, done?: () => void) => { setBusy(true); onError(null); try { await operation(); done?.(); } catch (reason) { onError(reason instanceof Error ? reason.message : t("team.operationFailed")); } finally { setBusy(false); } };
  return <div className="team-panel-section collaboration-section" aria-labelledby="collaboration-section-title">
    <div className="team-panel-label" id="collaboration-section-title">{t("collaboration.title")}</div>
    {!state && <div className="team-panel-hint">{t("collaboration.unavailable")}</div>}
    {state && <>
      <div className="collaboration-badge-list" aria-label={t("collaboration.ownership")}>
        {ownership.map((item, index) => <span className={`collaboration-owner-badge ${item.subject.kind}`} key={`${item.source}:${item.path}:${item.subject.id}:${index}`}>{item.subject.kind === "agent" ? t("collaboration.agent") : t("collaboration.human")} · {item.subject.id}{item.range ? ` · L${item.range.startLine}–${item.range.endLine}` : ""}</span>)}
        {changeSets.map((item) => <span className="collaboration-owner-badge agent" key={item.changeSetId}>{t("collaboration.changeSet")} · {item.subject.id} · {item.status}</span>)}
        {!ownership.length && !changeSets.length && <span className="team-panel-hint">{t("collaboration.unowned")}</span>}
      </div>
      {buffers.length > 0 && <div className="collaboration-buffer-warning" role="status"><strong>{t("collaboration.unsavedBuffers")}</strong>{buffers.map((buffer) => <span key={buffer.id}>{buffer.username} · {buffer.path} · v{buffer.version}</span>)}</div>}
      {!readOnly && activeFilePath && <div className="collaboration-compose">
        <label>{t("collaboration.comment")}<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={t("collaboration.commentPlaceholder")} /></label>
        <label>{t("collaboration.evidence")}<input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="run:… / https://…" /></label>
        <button type="button" disabled={busy || !comment.trim()} onClick={() => void invoke(() => onAddComment({ body: comment.trim(), path: activeFilePath, evidenceLinks: evidence.split(/\s+/).filter(Boolean) }), () => { setComment(""); setEvidence(""); })}>{t("collaboration.addComment")}</button>
        <div className="collaboration-review-compose"><select value={reviewer} onChange={(event) => setReviewer(event.target.value)}><option value="">{t("collaboration.selectReviewer")}</option>{members.map((member) => <option key={member.username} value={member.username}>{member.username}</option>)}</select><button type="button" disabled={busy || !reviewer} onClick={() => void invoke(() => onCreateReview({ assignees: [{ kind: "human", id: reviewer }], path: activeFilePath, message: comment.trim() || undefined }), () => setReviewer(""))}>{t("collaboration.requestReview")}</button></div>
      </div>}
      <div className="collaboration-thread-list">{comments.map((item) => <article key={item.id} className="collaboration-thread"><header><strong>{item.author.id}</strong><span>L{item.anchor.startLine} · {item.anchor.status}</span></header><p>{item.body}</p>{item.mentions.length > 0 && <small>{t("collaboration.mentions")}: {item.mentions.map((mention) => `@${mention.id}`).join(", ")}</small>}{item.evidenceLinks.length > 0 && <div className="collaboration-evidence-list">{item.evidenceLinks.map((link) => <code key={link}>{link}</code>)}</div>}</article>)}</div>
      {reviews.length > 0 && <div className="collaboration-review-list">{reviews.map((request) => <div key={request.id} className="collaboration-review-row"><strong>{t("collaboration.reviewRequest")}</strong><span>{request.assignees.map((item) => item.id).join(", ")} · {request.status}</span></div>)}</div>}
      {!readOnly && activeFilePath && changeSets.map((changeSet) => <button type="button" className="team-panel-btn collaboration-preview-btn" key={changeSet.changeSetId} disabled={busy} onClick={() => void invoke(() => onCreateMergePreview(changeSet.changeSetId, activeFilePath))}>{t("collaboration.previewConflict")} · {changeSet.changeSetId.slice(0, 10)}</button>)}
      {previews.slice(0, 2).map((preview) => {
        const actions = Array.isArray(preview.allowedActions) ? preview.allowedActions : [];
        const latestDecision = state.mergeDecisions.filter((decision) => decision.previewId === preview.id).sort((left, right) => right.createdAt - left.createdAt)[0];
        const pendingDecision = latestDecision && latestDecision.status !== "resolved" && latestDecision.choice !== "apply-agent" ? latestDecision : null;
        const pendingAction = pendingDecision ? actions.find((action) => action.choice === pendingDecision.choice) : undefined;
        return <article className="collaboration-merge-preview" key={preview.id}>
          <header><strong>{t("collaboration.threeWayPreview")}</strong><span>v{preview.version} · {preview.revision.slice(0, 10)}</span></header>
          <p>{t("collaboration.mergeSafetyWarning")}</p>
          {preview.hunks.map((hunk) => <div className="collaboration-merge-hunk" key={hunk.id}><span>{hunk.conflict ? t("collaboration.conflict") : t("collaboration.clean")}</span><pre>{hunk.upstream.slice(0, 1200)}</pre><pre>{hunk.agent.slice(0, 1200)}</pre></div>)}
          {latestDecision && <div className={`collaboration-decision-status ${latestDecision.status}`} role="status"><strong>{t(`collaboration.decisionStatus.${latestDecision.status}`)}</strong><span>{t(`collaboration.choice.${latestDecision.choice}`)}</span>{latestDecision.status === "resolved" && latestDecision.choice === "apply-agent" ? <small>{t("collaboration.agentDecisionResolved")}</small> : latestDecision.status === "resolved" && latestDecision.supersedesDecisionId ? <small>{t("collaboration.newRevisionResolved")}</small> : <small>{t("collaboration.originalRevisionBlocked")}</small>}</div>}
          {pendingDecision && <div className="collaboration-pending-requirements"><strong>{t("collaboration.pendingRequirements")}</strong>{pendingAction?.requiresSave && <span>{t("collaboration.requiresSave")}</span>}{pendingAction?.requiresNewRevision && <span>{t("collaboration.requiresNewRevision")}</span>}<button type="button" className="team-panel-btn" onClick={onRefresh}>{t("collaboration.refreshAfterRevision")}</button></div>}
          {!readOnly && <div className="collaboration-merge-actions">{actions.map((action) => {
            const prior = state.mergeDecisions.filter((decision) => decision.path === preview.path && decision.choice === action.choice && decision.revision !== preview.revision && decision.status !== "resolved").sort((left, right) => right.createdAt - left.createdAt)[0];
            return <div className="collaboration-merge-action" key={action.choice}>
              <button type="button" disabled={busy || !action.enabled} onClick={() => void invoke(() => onDecideMerge(preview, action.choice, undefined, action.choice === "manual" ? preview.humanDigest : undefined, prior?.id))}>{prior ? t("collaboration.finalizeNewRevision", { choice: t(`collaboration.choice.${action.choice}`) }) : t(`collaboration.choice.${action.choice}`)}</button>
              <small>{[action.requiresSave ? t("collaboration.requiresSave") : "", action.requiresNewRevision ? t("collaboration.requiresNewRevision") : "", action.reason || ""].filter(Boolean).join(" · ") || t("collaboration.exactDecision")}</small>
            </div>;
          })}</div>}
          {!actions.length && <div className="team-panel-hint">{t("collaboration.actionsUnavailable")}</div>}
        </article>;
      })}
      <div className="collaboration-activity-list">{state.activity.slice(0, 12).map((item) => <div key={item.id}><strong>{item.actorId}</strong><span>{item.type}{item.path ? ` · ${item.path}` : ""}{item.detail ? ` · ${item.detail}` : ""}</span>{item.evidenceLinks?.map((link) => <code key={link}>{link}</code>)}</div>)}</div>
    </>}
  </div>;
};

function describeActivity(
  entry: TeamDetails["activity"][number],
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  switch (entry.type) {
    case "team_created":
      return t("team.activityCreated");
    case "member_joined":
      return t("team.activityJoined");
    case "member_left":
      return t("team.activityLeft");
    case "member_removed":
      return t("team.activityRemoved", {
        username: String(entry.payload?.targetUsername || ""),
      });
    case "member_role_updated":
      return t("team.activityRoleUpdated", {
        username: String(entry.payload?.targetUsername || ""),
        role: String(entry.payload?.role || ""),
      });
    case "ownership_transferred":
      return t("team.activityOwnershipTransferred", {
        previousOwner: String(entry.payload?.previousOwner || ""),
        nextOwner: String(entry.payload?.nextOwner || ""),
      });
    case "invite_created":
      return t("team.activityInvite", {
        role: String(entry.payload?.role || "member"),
      });
    case "file_saved":
      if (entry.payload?.source === "assistant_tool") {
        return t("team.activitySavedByAssistant", {
          path: String(entry.payload?.path || ""),
        });
      }
      return Boolean(entry.payload?.forced) && entry.payload?.claimOwner
        ? t("team.activitySavedForced", {
            path: String(entry.payload?.path || ""),
            username: String(entry.payload?.claimOwner || ""),
          })
        : t("team.activitySaved", {
            path: String(entry.payload?.path || ""),
          });
    case "entry_created":
      return t("team.activityCreatedEntry", {
        path: String(entry.payload?.path || ""),
      });
    case "entry_copied":
      return t("team.activityCopiedEntry", {
        sourcePath: String(entry.payload?.sourcePath || ""),
        path: String(entry.payload?.path || ""),
      });
    case "entry_deleted":
      return t("team.activityDeletedEntry", {
        path: String(entry.payload?.path || ""),
      });
    case "entry_renamed":
      return t("team.activityRenamedEntry", {
        oldPath: String(entry.payload?.oldPath || ""),
        newPath: String(entry.payload?.newPath || ""),
      });
    case "claim_updated":
      return Boolean(entry.payload?.claimed)
        ? t("team.activityClaimed", {
            path: String(entry.payload?.path || ""),
          })
        : t("team.activityReleased", {
            path: String(entry.payload?.path || ""),
          });
    default:
      return entry.type;
  }
}
