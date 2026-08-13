import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeSet } from "../chat/changeSets.js";
import type { ManagedWorktree } from "../chat/worktrees.js";
import type { TeamDetails } from "../team/teamManager.js";
import { collectRepositoryOwnership } from "./ownershipResolver.js";

const team = {
  members: [{ username: "alice", role: "member", joinedAt: 1 }, { username: "bob", role: "member", joinedAt: 1 }],
  claims: [{ path: "src/claimed.ts", username: "bob", updatedAt: 2 }, { path: "src/hidden.ts", username: "mallory", updatedAt: 2 }],
  presence: [{ username: "bob", online: true, activeFilePath: "src/present.ts", updatedAt: 3 }, { username: "mallory", online: true, activeFilePath: "src/hidden-presence.ts", updatedAt: 3 }],
} as unknown as TeamDetails;
const worktrees = [{ id: "wt", path: "/workspace", ownerId: "bob" }] as ManagedWorktree[];
const changeSets = [
  { ownerId: "bob", changedFiles: ["src/change.ts"], createdAt: new Date(4).toISOString() },
  { ownerId: "mallory", changedFiles: ["src/hidden-change.ts"], createdAt: new Date(4).toISOString() },
] as unknown as ChangeSet[];

test("ownership collection includes team, worktree, and ChangeSet signals while filtering unauthorized owners", () => {
  const visible = collectRepositoryOwnership({ workspaceDir: "/workspace", viewer: { username: "alice", isAdmin: false }, relevantPaths: ["src/current.ts"], team, worktrees, changeSets });
  assert.deepEqual(visible.map((entry) => `${entry.source}:${entry.path}:${entry.owner}`), [
    "change_set:src/change.ts:bob", "claim:src/claimed.ts:bob", "worktree:src/current.ts:bob", "presence:src/present.ts:bob",
  ]);
  const admin = collectRepositoryOwnership({ workspaceDir: "/workspace", viewer: { username: "admin", isAdmin: true }, team, worktrees: [], changeSets });
  assert.equal(admin.some((entry) => entry.owner === "mallory"), true);
});
