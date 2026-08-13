import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { UserSession } from "../auth/sessionManager.js";
import { listChangeSets, type ChangeSet } from "../chat/changeSets.js";
import { listManagedWorktrees, type ManagedWorktree } from "../chat/worktrees.js";
import { getTeamManager } from "../team/sessionBridge.js";
import type { TeamDetails } from "../team/teamManager.js";
import { evaluateContextPath } from "../agent/contextPolicy.js";
import type { RepositoryOwnershipSignal } from "./types.js";

export interface RepositoryOwnershipViewer { username: string; isAdmin: boolean; }

function mainRepositoryRoot(workspaceDir: string): string {
  try {
    const common = execFileSync("git", ["-C", workspaceDir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.dirname(fs.realpathSync.native(common));
  } catch { return fs.realpathSync.native(path.resolve(workspaceDir)); }
}

export function collectRepositoryOwnership(input: {
  workspaceDir: string;
  viewer: RepositoryOwnershipViewer;
  relevantPaths?: string[];
  team?: TeamDetails | null;
  worktrees?: ManagedWorktree[];
  changeSets?: ChangeSet[];
}): RepositoryOwnershipSignal[] {
  const allowedOwners = new Set(input.team?.members.map((member) => member.username) || [input.viewer.username]);
  const ownerVisible = (owner: string) => input.viewer.isAdmin || allowedOwners.has(owner);
  const result = new Map<string, RepositoryOwnershipSignal>();
  const add = (signal: RepositoryOwnershipSignal) => {
    const decision = evaluateContextPath(signal.path);
    if (!decision.allowed || !decision.normalizedPath || !signal.owner || !ownerVisible(signal.owner)) return;
    const normalized = { ...signal, path: decision.normalizedPath };
    result.set(`${normalized.source}:${normalized.path}:${normalized.owner}`, normalized);
  };
  for (const claim of input.team?.claims || []) add({ path: claim.path, owner: claim.username, source: "claim", updatedAt: claim.updatedAt });
  for (const presence of input.team?.presence || []) if (presence.online && presence.activeFilePath) add({ path: presence.activeFilePath, owner: presence.username, source: "presence", updatedAt: presence.updatedAt });
  for (const changeSet of input.changeSets || []) if (changeSet.ownerId) for (const filePath of changeSet.changedFiles) add({ path: filePath, owner: changeSet.ownerId, source: "change_set", updatedAt: Date.parse(changeSet.createdAt) || undefined });
  let currentRoot: string;
  try { currentRoot = fs.realpathSync.native(path.resolve(input.workspaceDir)); } catch { currentRoot = path.resolve(input.workspaceDir); }
  const activeWorktree = (input.worktrees || []).find((worktree) => {
    try { return fs.realpathSync.native(worktree.path) === currentRoot; } catch { return path.resolve(worktree.path) === currentRoot; }
  });
  if (activeWorktree?.ownerId) for (const filePath of input.relevantPaths || []) add({ path: filePath, owner: activeWorktree.ownerId, source: "worktree" });
  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path) || left.source.localeCompare(right.source) || left.owner.localeCompare(right.owner));
}

/** Resolve only ownership the authenticated viewer is permitted to observe. */
export function resolveRepositoryOwnership(workspaceDir: string, viewer: RepositoryOwnershipViewer, relevantPaths: string[] = []): RepositoryOwnershipSignal[] {
  const repository = mainRepositoryRoot(workspaceDir);
  let team: TeamDetails | null = null;
  try {
    const manager = getTeamManager({ username: viewer.username } as UserSession);
    team = manager.getTeamByWorkspace(viewer.username, workspaceDir) || (repository !== path.resolve(workspaceDir) ? manager.getTeamByWorkspace(viewer.username, repository) : null);
  } catch { team = null; }
  let worktrees: ManagedWorktree[] = []; let changeSets: ChangeSet[] = [];
  try { worktrees = listManagedWorktrees(repository); } catch { /* non-Git workspace */ }
  try { changeSets = listChangeSets(repository); } catch { /* non-Git workspace */ }
  return collectRepositoryOwnership({ workspaceDir, viewer, relevantPaths, team, worktrees, changeSets });
}
