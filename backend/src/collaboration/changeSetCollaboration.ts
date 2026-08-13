import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getChangeSet } from "../chat/changeSets.js";
import { listManagedWorktrees } from "../chat/worktrees.js";
import { safePath } from "../utils/safePath.js";
import { CollaborationStore, collaborationDigest, type CollaborationMergePreview } from "./collaborationStore.js";

function readAgentContent(workspace: string, changeSetId: string, relative: string): string {
  const changeSet = getChangeSet(workspace, changeSetId);
  const worktree = listManagedWorktrees(workspace).find((item) => item.id === changeSet.worktreeId);
  if (!worktree) throw new Error("Change set worktree is unavailable for conflict preview");
  const target = safePath(relative, path.resolve(worktree.path));
  try { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Conflict preview target must be a bounded regular file"); return fs.readFileSync(target, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
function readBaseContent(workspace: string, revision: string, relative: string): string { try { return execFileSync("git", ["-C", workspace, "show", `${revision}:${relative}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch { return ""; } }

export function createChangeSetMergePreview(workspace: string, input: { changeSetId: string; path: string; actorId: string }): CollaborationMergePreview {
  const changeSet = getChangeSet(workspace, input.changeSetId);
  if (!changeSet.changedFiles.includes(input.path)) throw new Error("Conflict path is outside the change set");
  const store = new CollaborationStore(workspace);
  const agent = readAgentContent(workspace, changeSet.id, input.path);
  const digests = store.fileDigests(input.path, changeSet.baseSha, agent);
  const upstreamTarget = safePath(input.path, path.resolve(workspace));
  let upstream = ""; try { upstream = fs.readFileSync(upstreamTarget, "utf8"); } catch { /* deletion */ }
  const base = readBaseContent(workspace, changeSet.baseSha, input.path);
  const hunk = { id: collaborationDigest(`${input.path}\0${digests.base}\0${digests.human}\0${digests.upstream}\0${digests.agent}`).slice(0, 24), base, upstream, agent, conflict: digests.human !== digests.agent || digests.upstream !== digests.agent };
  return store.recordMergePreview({ changeSetId: changeSet.id, path: input.path, revision: changeSet.patchSha256, baseDigest: digests.base, humanDigest: digests.human, upstreamDigest: digests.upstream, agentDigest: digests.agent, hunks: [hunk], createdBy: input.actorId });
}
