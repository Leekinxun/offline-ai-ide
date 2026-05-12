import React, { useMemo, useState } from "react";
import { TeamDetails, TeamRole, TeamSummary } from "../types";
import { useI18n } from "../i18n";
import { Copy, Plus, RefreshCw, Users } from "lucide-react";

interface TeamPanelProps {
  teams: TeamSummary[];
  activeTeam: TeamDetails | null;
  currentUsername: string;
  connected: boolean;
  loading: boolean;
  error: string | null;
  activeFilePath: string | null;
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
}

export const TeamPanel: React.FC<TeamPanelProps> = ({
  teams,
  activeTeam,
  currentUsername,
  connected,
  loading,
  error,
  activeFilePath,
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
}) => {
  const { t } = useI18n();
  const [teamName, setTeamName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [lastInvite, setLastInvite] = useState<string | null>(null);

  const activeClaim = useMemo(
    () => activeTeam?.claims.find((claim) => claim.path === activeFilePath) || null,
    [activeTeam, activeFilePath]
  );
  const canManageTeam = activeTeam?.role === "owner" || activeTeam?.role === "admin";
  const canClaimFile = activeTeam?.role !== "viewer";
  const currentRole = activeTeam?.role || null;
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
    try {
      await onCreateTeam(teamName.trim());
      setTeamName("");
    } catch {
      // toast handled by caller
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    if (!inviteCode.trim() || joining) return;
    setJoining(true);
    try {
      await onJoinTeam(inviteCode.trim());
      setInviteCode("");
    } catch {
      // toast handled by caller
    } finally {
      setJoining(false);
    }
  };

  const handleInvite = async () => {
    if (!activeTeam || inviteBusy) return;
    setInviteBusy(true);
    try {
      const code = await onCreateInvite(activeTeam.id, inviteRole);
      setLastInvite(code);
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(code);
      }
    } catch {
      // toast handled by caller
    } finally {
      setInviteBusy(false);
    }
  };

  return (
    <div className="team-panel">
      <div className="team-panel-header">
        <div className="team-panel-title">
          <Users size={15} />
          <span>{t("team.title")}</span>
        </div>
        <button className="sidebar-action-btn" onClick={onRefresh} title={t("team.refresh")}>
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="team-panel-section">
        <div className="team-panel-status">
          <span
            className={`team-dot${connected ? " online" : ""}`}
          />
          <span>{connected ? t("team.connected") : t("team.disconnected")}</span>
        </div>
        {error && <div className="team-panel-error">{error}</div>}
      </div>

      <div className="team-panel-section">
        <div className="team-panel-label">{t("team.switcher")}</div>
        <select
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

      <div className="team-panel-section">
        <div className="team-panel-label">{t("team.create")}</div>
        <div className="team-panel-inline">
          <input
            className="dialog-input team-panel-input"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder={t("team.teamNamePlaceholder")}
          />
          <button
            className="team-panel-btn primary"
            onClick={handleCreate}
            disabled={!teamName.trim() || creating}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="team-panel-section">
        <div className="team-panel-label">{t("team.joinByInvite")}</div>
        <div className="team-panel-inline">
          <input
            className="dialog-input team-panel-input"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            placeholder={t("team.inviteCodePlaceholder")}
          />
          <button
            className="team-panel-btn"
            onClick={handleJoin}
            disabled={!inviteCode.trim() || joining}
          >
            {t("team.join")}
          </button>
        </div>
      </div>

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
                <button className="team-panel-btn danger" onClick={() => void onLeaveTeam()}>
                  {t("team.leaveTeam")}
                </button>
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
                  className="team-panel-btn"
                  onClick={handleInvite}
                  disabled={inviteBusy || !canManageTeam}
                  title={!canManageTeam ? t("team.inviteRestricted") : undefined}
                >
                  <Copy size={13} />
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
                          <span className={`team-dot${presence?.online ? " online" : ""}`} />
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
                              className="team-panel-btn danger"
                              onClick={() => void onRemoveMember(member.username)}
                            >
                              {t("team.removeMember")}
                            </button>
                            {currentRole === "owner" && member.role !== "owner" ? (
                              <button
                                className="team-panel-btn"
                                onClick={() => void onTransferOwnership(member.username)}
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
                <button
                  className="team-panel-btn"
                  onClick={() =>
                    void onToggleClaim(activeFilePath, activeClaim?.username ? false : true)
                  }
                  disabled={!canClaimFile}
                  title={!canClaimFile ? t("team.claimRestricted") : undefined}
                >
                  {activeClaim?.username ? t("team.releaseClaim") : t("team.claimFile")}
                </button>
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
        </>
      )}

      {loading && <div className="team-panel-loading">{t("common.loading")}</div>}
    </div>
  );
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
