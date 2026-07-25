import crypto from "crypto";
import fs from "fs";
import path from "path";

export type TeamRole = "owner" | "admin" | "member" | "viewer";

export interface TeamMemberRecord {
  username: string;
  role: TeamRole;
  joinedAt: number;
}

export interface TeamInviteRecord {
  code: string;
  role: TeamRole;
  createdBy: string;
  createdAt: number;
  usedBy?: string;
  usedAt?: number;
}

export interface TeamClaimRecord {
  path: string;
  username: string;
  updatedAt: number;
}

export interface TeamPresenceRecord {
  username: string;
  online: boolean;
  activeFilePath?: string;
  cursorLine?: number;
  cursorColumn?: number;
  activity?: string;
  updatedAt: number;
}

export interface TeamActivityRecord {
  id: string;
  type:
    | "team_created"
    | "member_joined"
    | "member_left"
    | "member_removed"
    | "member_role_updated"
    | "ownership_transferred"
    | "invite_created"
    | "file_saved"
    | "entry_created"
    | "entry_copied"
    | "entry_deleted"
    | "entry_renamed"
    | "claim_updated";
  username: string;
  createdAt: number;
  payload?: Record<string, unknown>;
}

export interface TeamRecord {
  id: string;
  name: string;
  workspaceDir: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  members: TeamMemberRecord[];
  invites: TeamInviteRecord[];
  claims: TeamClaimRecord[];
  presence: TeamPresenceRecord[];
  activity: TeamActivityRecord[];
}

interface TeamIndexRecord {
  teams: TeamRecord[];
  userTeams: Record<string, string[]>;
}

interface TeamSummary {
  id: string;
  name: string;
  workspaceDir: string;
  memberCount: number;
  onlineCount: number;
  role: TeamRole | null;
}

export interface TeamDetails extends TeamSummary {
  members: TeamMemberRecord[];
  invites: TeamInviteRecord[];
  claims: TeamClaimRecord[];
  presence: TeamPresenceRecord[];
  activity: TeamActivityRecord[];
}

function createDefaultIndex(): TeamIndexRecord {
  return {
    teams: [],
    userTeams: {},
  };
}

function normalizeRole(value: unknown): TeamRole {
  return value === "owner" || value === "admin" || value === "viewer"
    ? value
    : "member";
}

export class TeamManager {
  private readonly dataPath: string;

  constructor(private readonly rootDir: string) {
    this.dataPath = path.join(path.resolve(rootDir), ".team", "teams.json");
    fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
  }

  private readIndex(): TeamIndexRecord {
    try {
      const raw = fs.readFileSync(this.dataPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<TeamIndexRecord>;
      const teams = Array.isArray(parsed.teams)
        ? parsed.teams
            .filter((team): team is TeamRecord => Boolean(team && typeof team === "object"))
            .map((team) => this.normalizeTeam(team))
        : [];
      const userTeams =
        parsed.userTeams && typeof parsed.userTeams === "object"
          ? Object.fromEntries(
              Object.entries(parsed.userTeams).map(([username, ids]) => [
                username,
                Array.isArray(ids)
                  ? ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
                  : [],
              ])
            )
          : {};
      return { teams, userTeams };
    } catch {
      return createDefaultIndex();
    }
  }

  private writeIndex(index: TeamIndexRecord): void {
    fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
    fs.writeFileSync(this.dataPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
  }

  private normalizeTeam(team: Partial<TeamRecord>): TeamRecord {
    const now = Date.now();
    return {
      id: typeof team.id === "string" && team.id.trim() ? team.id : crypto.randomUUID(),
      name: typeof team.name === "string" && team.name.trim() ? team.name.trim() : "Untitled Team",
      workspaceDir:
        typeof team.workspaceDir === "string" && team.workspaceDir.trim()
          ? path.resolve(team.workspaceDir)
          : path.resolve(this.rootDir),
      createdBy: typeof team.createdBy === "string" ? team.createdBy : "unknown",
      createdAt:
        typeof team.createdAt === "number" && Number.isFinite(team.createdAt)
          ? team.createdAt
          : now,
      updatedAt:
        typeof team.updatedAt === "number" && Number.isFinite(team.updatedAt)
          ? team.updatedAt
          : now,
      members: Array.isArray(team.members)
        ? team.members
            .filter((member): member is TeamMemberRecord => Boolean(member && typeof member === "object"))
            .map((member) => ({
              username: typeof member.username === "string" ? member.username : "unknown",
              role: normalizeRole(member.role),
              joinedAt:
                typeof member.joinedAt === "number" && Number.isFinite(member.joinedAt)
                  ? member.joinedAt
                  : now,
            }))
        : [],
      invites: Array.isArray(team.invites)
        ? team.invites
            .filter((invite): invite is TeamInviteRecord => Boolean(invite && typeof invite === "object"))
            .map((invite) => ({
              code:
                typeof invite.code === "string" && invite.code.trim()
                  ? invite.code
                  : this.createInviteCode(),
              role: normalizeRole(invite.role),
              createdBy: typeof invite.createdBy === "string" ? invite.createdBy : "unknown",
              createdAt:
                typeof invite.createdAt === "number" && Number.isFinite(invite.createdAt)
                  ? invite.createdAt
                  : now,
              ...(typeof invite.usedBy === "string" && invite.usedBy
                ? { usedBy: invite.usedBy }
                : {}),
              ...(typeof invite.usedAt === "number" && Number.isFinite(invite.usedAt)
                ? { usedAt: invite.usedAt }
                : {}),
            }))
        : [],
      claims: Array.isArray(team.claims)
        ? team.claims
            .filter((claim): claim is TeamClaimRecord => Boolean(claim && typeof claim === "object"))
            .map((claim) => ({
              path: typeof claim.path === "string" ? claim.path : "",
              username: typeof claim.username === "string" ? claim.username : "unknown",
              updatedAt:
                typeof claim.updatedAt === "number" && Number.isFinite(claim.updatedAt)
                  ? claim.updatedAt
                  : now,
            }))
            .filter((claim) => claim.path)
        : [],
      presence: Array.isArray(team.presence)
        ? team.presence
            .filter((presence): presence is TeamPresenceRecord => Boolean(presence && typeof presence === "object"))
            .map((presence) => ({
              username: typeof presence.username === "string" ? presence.username : "unknown",
              online: Boolean(presence.online),
              ...(typeof presence.activeFilePath === "string" && presence.activeFilePath
                ? { activeFilePath: presence.activeFilePath }
                : {}),
              ...(typeof presence.cursorLine === "number" && Number.isFinite(presence.cursorLine)
                ? { cursorLine: presence.cursorLine }
                : {}),
              ...(typeof presence.cursorColumn === "number" && Number.isFinite(presence.cursorColumn)
                ? { cursorColumn: presence.cursorColumn }
                : {}),
              ...(typeof presence.activity === "string" && presence.activity
                ? { activity: presence.activity }
                : {}),
              updatedAt:
                typeof presence.updatedAt === "number" && Number.isFinite(presence.updatedAt)
                  ? presence.updatedAt
                  : now,
            }))
        : [],
      activity: Array.isArray(team.activity)
        ? team.activity
            .filter((activity): activity is TeamActivityRecord => Boolean(activity && typeof activity === "object"))
            .map((activity) => ({
              id: typeof activity.id === "string" ? activity.id : crypto.randomUUID(),
              type:
                activity.type === "team_created" ||
                activity.type === "member_joined" ||
                activity.type === "member_left" ||
                activity.type === "member_removed" ||
                activity.type === "member_role_updated" ||
                activity.type === "ownership_transferred" ||
                activity.type === "invite_created" ||
                activity.type === "file_saved" ||
                activity.type === "entry_created" ||
                activity.type === "entry_copied" ||
                activity.type === "entry_deleted" ||
                activity.type === "entry_renamed" ||
                activity.type === "claim_updated"
                  ? activity.type
                  : "file_saved",
              username: typeof activity.username === "string" ? activity.username : "unknown",
              createdAt:
                typeof activity.createdAt === "number" && Number.isFinite(activity.createdAt)
                  ? activity.createdAt
                  : now,
              ...(activity.payload && typeof activity.payload === "object"
                ? { payload: activity.payload }
                : {}),
            }))
        : [],
    };
  }

  private ensureUserTeams(index: TeamIndexRecord, username: string): string[] {
    if (!Array.isArray(index.userTeams[username])) {
      index.userTeams[username] = [];
    }
    return index.userTeams[username];
  }

  private getTeam(index: TeamIndexRecord, teamId: string): TeamRecord | undefined {
    return index.teams.find((team) => team.id === teamId);
  }

  private getTeamRole(team: TeamRecord, username: string): TeamRole | null {
    const member = team.members.find((entry) => entry.username === username);
    return member?.role || null;
  }

  private getTeamMember(team: TeamRecord, username: string): TeamMemberRecord | null {
    return team.members.find((entry) => entry.username === username) || null;
  }

  private canManageTeam(team: TeamRecord, username: string): boolean {
    const role = this.getTeamRole(team, username);
    return role === "owner" || role === "admin";
  }

  private countOwners(team: TeamRecord): number {
    return team.members.filter((member) => member.role === "owner").length;
  }

  private removeUserTeam(index: TeamIndexRecord, username: string, teamId: string): void {
    index.userTeams[username] = this.ensureUserTeams(index, username).filter((id) => id !== teamId);
  }

  private trimActivity(activity: TeamActivityRecord[]): TeamActivityRecord[] {
    return activity
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 100);
  }

  private createInviteCode(): string {
    return Math.random().toString(36).slice(2, 10).toUpperCase();
  }

  private toSummary(team: TeamRecord, username: string): TeamSummary {
    return {
      id: team.id,
      name: team.name,
      workspaceDir: team.workspaceDir,
      memberCount: team.members.length,
      onlineCount: team.presence.filter((entry) => entry.online).length,
      role: this.getTeamRole(team, username),
    };
  }

  private toDetails(team: TeamRecord, username: string): TeamDetails {
    return {
      ...this.toSummary(team, username),
      members: team.members.slice().sort((a, b) => a.username.localeCompare(b.username)),
      invites: team.invites
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt),
      claims: team.claims
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path)),
      presence: team.presence
        .slice()
        .sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username)),
      activity: team.activity
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 40),
    };
  }

  listTeams(username: string): TeamSummary[] {
    const index = this.readIndex();
    const teamIds = new Set(this.ensureUserTeams(index, username));
    return index.teams
      .filter((team) => team.members.some((member) => member.username === username) || teamIds.has(team.id))
      .map((team) => this.toSummary(team, username))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getTeamDetails(teamId: string, username: string): TeamDetails {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      throw new Error("Team not found");
    }
    if (!team.members.some((member) => member.username === username)) {
      throw new Error("Forbidden");
    }
    return this.toDetails(team, username);
  }

  createTeam(input: {
    username: string;
    teamName: string;
    workspaceDir: string;
  }): TeamDetails {
    const index = this.readIndex();
    const now = Date.now();
    const team: TeamRecord = {
      id: crypto.randomUUID(),
      name: input.teamName.trim(),
      workspaceDir: path.resolve(input.workspaceDir),
      createdBy: input.username,
      createdAt: now,
      updatedAt: now,
      members: [
        {
          username: input.username,
          role: "owner",
          joinedAt: now,
        },
      ],
      invites: [],
      claims: [],
      presence: [],
      activity: [
        {
          id: crypto.randomUUID(),
          type: "team_created",
          username: input.username,
          createdAt: now,
          payload: {
            name: input.teamName.trim(),
            workspaceDir: path.resolve(input.workspaceDir),
          },
        },
      ],
    };

    index.teams.push(team);
    this.ensureUserTeams(index, input.username).push(team.id);
    this.writeIndex(index);
    return this.toDetails(team, input.username);
  }

  createInvite(teamId: string, username: string, role: TeamRole): TeamInviteRecord {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      throw new Error("Team not found");
    }
    if (!this.canManageTeam(team, username)) {
      throw new Error("Forbidden");
    }
    const actorRole = this.getTeamRole(team, username);
    if (role === "owner") {
      throw new Error("Owner role must be transferred explicitly");
    }
    if (actorRole === "admin" && role === "admin") {
      throw new Error("Forbidden");
    }

    const invite: TeamInviteRecord = {
      code: this.createInviteCode(),
      role,
      createdBy: username,
      createdAt: Date.now(),
    };

    team.invites = [invite, ...team.invites].slice(0, 20);
    team.activity = this.trimActivity([
      {
        id: crypto.randomUUID(),
        type: "invite_created",
        username,
        createdAt: Date.now(),
        payload: {
          code: invite.code,
          role,
        },
      },
      ...team.activity,
    ]);
    team.updatedAt = Date.now();
    this.writeIndex(index);
    return invite;
  }

  joinTeamByInvite(code: string, username: string): TeamDetails {
    const index = this.readIndex();
    const inviteCode = code.trim().toUpperCase();
    const team = index.teams.find((entry) =>
      entry.invites.some((invite) => invite.code === inviteCode && !invite.usedBy)
    );

    if (!team) {
      throw new Error("Invite not found");
    }

    const invite = team.invites.find((entry) => entry.code === inviteCode && !entry.usedBy);
    if (!invite) {
      throw new Error("Invite already used");
    }

    if (team.members.some((member) => member.username === username)) {
      return this.toDetails(team, username);
    }

    const now = Date.now();
    team.members.push({
      username,
      role: invite.role,
      joinedAt: now,
    });
    invite.usedBy = username;
    invite.usedAt = now;
    team.updatedAt = now;
    team.activity = this.trimActivity([
      {
        id: crypto.randomUUID(),
        type: "member_joined",
        username,
        createdAt: now,
        payload: {
          role: invite.role,
        },
      },
      ...team.activity,
    ]);

    const userTeams = this.ensureUserTeams(index, username);
    if (!userTeams.includes(team.id)) {
      userTeams.push(team.id);
    }

    this.writeIndex(index);
    return this.toDetails(team, username);
  }

  syncUserWorkspaceTeam(username: string, workspaceDir: string): TeamDetails | null {
    const target = path.resolve(workspaceDir);
    const index = this.readIndex();
    const team = index.teams.find(
      (entry) =>
        entry.workspaceDir === target &&
        entry.members.some((member) => member.username === username)
    );
    return team ? this.toDetails(team, username) : null;
  }

  getTeamByWorkspace(username: string, workspaceDir: string): TeamDetails | null {
    return this.syncUserWorkspaceTeam(username, workspaceDir);
  }

  upsertPresence(
    teamId: string,
    username: string,
    update: Partial<Omit<TeamPresenceRecord, "username" | "updatedAt">>
  ): TeamDetails {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      throw new Error("Team not found");
    }
    if (!team.members.some((member) => member.username === username)) {
      throw new Error("Forbidden");
    }

    const now = Date.now();
    const current = team.presence.find((entry) => entry.username === username);
    const next: TeamPresenceRecord = {
      username,
      online: update.online ?? current?.online ?? true,
      activeFilePath: update.activeFilePath ?? current?.activeFilePath,
      cursorLine: update.cursorLine ?? current?.cursorLine,
      cursorColumn: update.cursorColumn ?? current?.cursorColumn,
      activity: update.activity ?? current?.activity,
      updatedAt: now,
    };

    team.presence = [
      ...team.presence.filter((entry) => entry.username !== username),
      next,
    ];
    team.updatedAt = now;
    this.writeIndex(index);
    return this.toDetails(team, username);
  }

  setOffline(teamId: string, username: string): TeamDetails | null {
    try {
      return this.upsertPresence(teamId, username, { online: false, activity: "offline" });
    } catch {
      return null;
    }
  }

  updateClaim(teamId: string, username: string, filePath: string, claimed: boolean): TeamDetails {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      throw new Error("Team not found");
    }
    if (!team.members.some((member) => member.username === username)) {
      throw new Error("Forbidden");
    }

    const now = Date.now();
    team.claims = team.claims.filter((claim) => claim.path !== filePath);
    if (claimed) {
      team.claims.push({
        path: filePath,
        username,
        updatedAt: now,
      });
    }
    team.updatedAt = now;
    team.activity = this.trimActivity([
      {
        id: crypto.randomUUID(),
        type: "claim_updated",
        username,
        createdAt: now,
        payload: {
          path: filePath,
          claimed,
        },
      },
      ...team.activity,
    ]);
    this.writeIndex(index);
    return this.toDetails(team, username);
  }

  updateMemberRole(
    teamId: string,
    actorUsername: string,
    targetUsername: string,
    nextRoleInput: TeamRole
  ): TeamDetails {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      throw new Error("Team not found");
    }

    const actor = this.getTeamMember(team, actorUsername);
    const target = this.getTeamMember(team, targetUsername);
    if (!actor || !target) {
      throw new Error("Forbidden");
    }
    if (actor.username === target.username) {
      throw new Error("You cannot change your own role");
    }

    const nextRole = normalizeRole(nextRoleInput);
    const previousRole = target.role;
    if (previousRole === nextRole) {
      return this.toDetails(team, actorUsername);
    }

    if (actor.role === "admin") {
      if (target.role === "owner" || target.role === "admin") {
        throw new Error("Forbidden");
      }
      if (nextRole === "owner" || nextRole === "admin") {
        throw new Error("Forbidden");
      }
    } else if (actor.role !== "owner") {
      throw new Error("Forbidden");
    }

    if (target.role === "owner" && nextRole !== "owner" && this.countOwners(team) <= 1) {
      throw new Error("At least one owner must remain");
    }

    target.role = nextRole;
    if (nextRole === "viewer") {
      team.claims = team.claims.filter((claim) => claim.username !== target.username);
    }
    const now = Date.now();
    team.updatedAt = now;
    team.activity = this.trimActivity([
      {
        id: crypto.randomUUID(),
        type: "member_role_updated",
        username: actorUsername,
        createdAt: now,
        payload: {
          targetUsername,
          previousRole,
          role: nextRole,
        },
      },
      ...team.activity,
    ]);
    this.writeIndex(index);
    return this.toDetails(team, actorUsername);
  }

  transferOwnership(teamId: string, actorUsername: string, targetUsername: string): TeamDetails {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      throw new Error("Team not found");
    }

    const actor = this.getTeamMember(team, actorUsername);
    const target = this.getTeamMember(team, targetUsername);
    if (!actor || !target) {
      throw new Error("Forbidden");
    }
    if (actor.role !== "owner") {
      throw new Error("Forbidden");
    }
    if (actor.username === target.username) {
      throw new Error("Target owner must be another member");
    }

    const previousTargetRole = target.role;
    actor.role = "admin";
    target.role = "owner";

    const now = Date.now();
    team.updatedAt = now;
    team.activity = this.trimActivity([
      {
        id: crypto.randomUUID(),
        type: "ownership_transferred",
        username: actorUsername,
        createdAt: now,
        payload: {
          previousOwner: actorUsername,
          nextOwner: targetUsername,
          previousTargetRole,
        },
      },
      ...team.activity,
    ]);
    this.writeIndex(index);
    return this.toDetails(team, actorUsername);
  }

  removeMember(teamId: string, actorUsername: string, targetUsername: string): void {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      throw new Error("Team not found");
    }

    const actor = this.getTeamMember(team, actorUsername);
    const target = this.getTeamMember(team, targetUsername);
    if (!actor || !target) {
      throw new Error("Forbidden");
    }
    if (actor.username === target.username) {
      throw new Error("Use leave team instead");
    }

    if (actor.role === "admin") {
      if (target.role === "owner" || target.role === "admin") {
        throw new Error("Forbidden");
      }
    } else if (actor.role !== "owner") {
      throw new Error("Forbidden");
    }

    if (target.role === "owner" && this.countOwners(team) <= 1) {
      throw new Error("At least one owner must remain");
    }

    const removedRole = target.role;
    team.members = team.members.filter((member) => member.username !== targetUsername);
    team.presence = team.presence.filter((entry) => entry.username !== targetUsername);
    team.claims = team.claims.filter((entry) => entry.username !== targetUsername);
    this.removeUserTeam(index, targetUsername, team.id);

    const now = Date.now();
    team.updatedAt = now;
    team.activity = this.trimActivity([
      {
        id: crypto.randomUUID(),
        type: "member_removed",
        username: actorUsername,
        createdAt: now,
        payload: {
          targetUsername,
          role: removedRole,
        },
      },
      ...team.activity,
    ]);
    this.writeIndex(index);
  }

  leaveTeam(teamId: string, username: string): void {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      throw new Error("Team not found");
    }

    const member = this.getTeamMember(team, username);
    if (!member) {
      throw new Error("Forbidden");
    }
    if (member.role === "owner" && this.countOwners(team) <= 1) {
      throw new Error("At least one owner must remain");
    }

    const role = member.role;
    team.members = team.members.filter((entry) => entry.username !== username);
    team.presence = team.presence.filter((entry) => entry.username !== username);
    team.claims = team.claims.filter((entry) => entry.username !== username);
    this.removeUserTeam(index, username, team.id);

    const now = Date.now();
    team.updatedAt = now;
    team.activity = this.trimActivity([
      {
        id: crypto.randomUUID(),
        type: "member_left",
        username,
        createdAt: now,
        payload: {
          role,
        },
      },
      ...team.activity,
    ]);
    this.writeIndex(index);
  }

  appendActivity(
    teamId: string,
    input: {
      type: TeamActivityRecord["type"];
      username: string;
      payload?: Record<string, unknown>;
    }
  ): TeamDetails | null {
    const index = this.readIndex();
    const team = this.getTeam(index, teamId);
    if (!team) {
      return null;
    }
    const now = Date.now();
    team.activity = this.trimActivity([
      {
        id: crypto.randomUUID(),
        type: input.type,
        username: input.username,
        createdAt: now,
        ...(input.payload ? { payload: input.payload } : {}),
      },
      ...team.activity,
    ]);
    team.updatedAt = now;
    this.writeIndex(index);
    return this.toDetails(team, input.username);
  }
}
