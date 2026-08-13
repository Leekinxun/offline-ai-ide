import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "../../agent/secretRedaction.js";
import { changeSetReviewRevision, getChangeSet, preflightChangeSetDecision } from "../../chat/changeSets.js";
import { listChangeSetReviewRuns, reconstructChangeSetCheckout } from "../../chat/changeSetReviewRun.js";
import { readExecutionPlan } from "../../chat/executionPlans.js";
import { readRunRecord } from "../../chat/runHistory.js";
import { TraceStore } from "../../chat/traceStore.js";
import { resolveGitWorkspaceContext } from "../../files/gitStatus.js";
import { GitDeliveryStore, GitOperationVersionConflictError } from "./store.js";
import type {
  GitDeliveryActor,
  GitDeliveryInput,
  GitDeliveryPrepareRequest,
  GitDeliveryProvenance,
  GitEvidenceSummary,
  GitOperation,
  GitOperationPreflight,
} from "./types.js";

const SHA = /^[a-f0-9]{40,64}$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ZERO_SHA = "0000000000000000000000000000000000000000";
const TERMINAL = new Set(["completed", "conflicted", "failed", "cancelled", "manual_recovery"]);

export class GitDeliveryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly current?: GitOperation) {
    super(message);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };
}

function git(directory: string, args: string[], options: { input?: string; timeout?: number; allowFailure?: boolean } = {}): string {
  const safeArgs = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "core.pager=cat",
    "-C", directory,
    ...args,
  ];
  try {
    return execFileSync("git", safeArgs, {
      encoding: "utf8",
      input: options.input,
      timeout: options.timeout || 30_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: gitEnv(),
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() || "";
    throw new GitDeliveryError("GIT_COMMAND_FAILED", redactSecrets(stderr.trim() || "Git command failed").slice(0, 2000));
  }
}

function gitSucceeds(directory: string, args: string[]): boolean {
  try { git(directory, args); return true; }
  catch { return false; }
}

function repository(workspaceDir: string): string {
  return resolveGitWorkspaceContext(workspaceDir).repoRoot;
}

function repositoryId(repositoryDir: string): string {
  const common = git(repositoryDir, ["rev-parse", "--git-common-dir"]);
  return digest(`${fs.realpathSync.native(repositoryDir)}\0${path.resolve(repositoryDir, common)}`);
}

function validateSha(repositoryDir: string, value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new GitDeliveryError("INVALID_SHA", `${field} must be a full commit SHA`);
  const resolved = git(repositoryDir, ["rev-parse", "--verify", `${value}^{commit}`]);
  if (!SHA.test(resolved)) throw new GitDeliveryError("INVALID_SHA", `${field} is not a commit`);
  return resolved;
}

function validateShaSyntax(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new GitDeliveryError("INVALID_SHA", `${field} must be a full commit SHA`);
  return value;
}

function validateBranch(repositoryDir: string, value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || value.startsWith("-") || /[\0\r\n]/.test(value)) throw new GitDeliveryError("INVALID_BRANCH", "Invalid branch name");
  try { git(repositoryDir, ["check-ref-format", "--branch", value]); } catch { throw new GitDeliveryError("INVALID_BRANCH", "Invalid branch name"); }
  return value;
}

function branchRef(repositoryDir: string, branch: string): string {
  return `refs/heads/${validateBranch(repositoryDir, branch)}`;
}

function refSha(repositoryDir: string, ref: string): string | null {
  const value = git(repositoryDir, ["show-ref", "--verify", "--hash", ref], { allowFailure: true });
  return SHA.test(value) ? value : null;
}

function validateRemoteRef(value: unknown): string {
  if (typeof value !== "string" || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(value) || value.includes("..") || value.endsWith("/") || /[\0\r\n]/.test(value)) throw new GitDeliveryError("INVALID_REMOTE_REF", "remoteRef must be a full heads ref");
  return value;
}

function expectedLocalSha(repositoryDir: string, value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : validateSha(repositoryDir, value, field);
}

function expectedRemoteSha(value: unknown): string | null {
  return value === null || value === undefined ? null : validateShaSyntax(value, "expectedRemoteSha");
}

function checkedOutBranches(repositoryDir: string): Set<string> {
  const result = new Set<string>();
  for (const line of git(repositoryDir, ["worktree", "list", "--porcelain"]).split(/\r?\n/)) {
    if (line.startsWith("branch refs/heads/")) result.add(line.slice("branch refs/heads/".length));
  }
  return result;
}

function protectedBranch(branch: string): boolean {
  return branch === "main" || branch === "master" || branch.startsWith("release/");
}

function authorize(actor: GitDeliveryActor, input: GitDeliveryInput): string[] {
  const reasons: string[] = [];
  if (actor.teamRole === "viewer") reasons.push("Active team role is read-only");
  const branch = "branch" in input ? input.branch : input.action === "push" ? input.remoteRef.slice("refs/heads/".length) : "";
  const manager = actor.isAdmin || actor.teamRole === "owner" || actor.teamRole === "admin" || actor.teamRole === undefined;
  if (input.action === "push" && !manager) reasons.push("Only workspace or team managers can push");
  if (branch && protectedBranch(branch) && !manager) reasons.push("Protected branches require owner/admin authorization");
  if (actor.teamRole === "member" && branch && !branch.startsWith("crewforge/")) reasons.push("Team members can prepare only crewforge/* delivery branches");
  return reasons;
}

function validateProvenance(repositoryDir: string, provenance: GitDeliveryProvenance, input: GitDeliveryInput): GitDeliveryProvenance {
  const normalized: GitDeliveryProvenance = {};
  for (const [key, value] of Object.entries(provenance)) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new GitDeliveryError("INVALID_PROVENANCE", `Invalid ${key}`);
    (normalized as Record<string, string>)[key] = value;
  }
  if (input.action === "commit_change_set") {
    if (normalized.changeSetId && normalized.changeSetId !== input.changeSetId) throw new GitDeliveryError("PROVENANCE_MISMATCH", "Provenance changeSetId does not match the request");
    normalized.changeSetId = input.changeSetId;
    const changeSet = getChangeSet(repositoryDir, input.changeSetId);
    if (normalized.worktreeId && normalized.worktreeId !== changeSet.worktreeId) throw new GitDeliveryError("PROVENANCE_MISMATCH", "Provenance worktreeId does not match the change set");
    normalized.worktreeId = changeSet.worktreeId;
    if (normalized.runId && normalized.runId !== changeSet.childRunId && normalized.runId !== changeSet.parentRunId) throw new GitDeliveryError("PROVENANCE_MISMATCH", "Provenance runId does not match the change set lineage");
  }
  if (normalized.runId) {
    const run = readRunRecord(repositoryDir, normalized.runId);
    if (normalized.conversationId && run.conversationId !== normalized.conversationId) throw new GitDeliveryError("PROVENANCE_MISMATCH", "Conversation does not own the selected run");
    normalized.conversationId = run.conversationId;
    if (normalized.planId && run.executionPlanId !== normalized.planId) throw new GitDeliveryError("PROVENANCE_MISMATCH", "Plan does not own the selected run");
    if (run.executionPlanId) normalized.planId = run.executionPlanId;
  }
  if (normalized.planId) readExecutionPlan(repositoryDir, normalized.planId);
  return normalized;
}

function evidenceSummary(repositoryDir: string, input: Extract<GitDeliveryInput, { action: "commit_change_set" }>, provenance: GitDeliveryProvenance, actor: GitDeliveryActor): GitEvidenceSummary {
  const changeSet = getChangeSet(repositoryDir, input.changeSetId);
  if (changeSet.status !== "ready_for_review") throw new GitDeliveryError("CHANGE_SET_NOT_READY", "Change set is not ready for delivery");
  const review = preflightChangeSetDecision(repositoryDir, changeSet, "apply", { id: actor.username, isAdmin: actor.isAdmin });
  if (review.blockingFindings?.length) throw new GitDeliveryError("REVIEW_GATE_FAILED", "Change set review or evidence gate is unmet", 409);
  const reviewRuns = listChangeSetReviewRuns(repositoryDir, changeSet.id).filter((run) => run.status === "completed" && run.revision === changeSetReviewRevision(changeSet));
  if (!reviewRuns.length) throw new GitDeliveryError("REVIEW_GATE_FAILED", "Completed independent review is required", 409);
  const checkout = reconstructChangeSetCheckout(repositoryDir, changeSet);
  checkout.cleanup();
  const runId = provenance.runId || changeSet.childRunId || changeSet.parentRunId;
  let conversationId = provenance.conversationId;
  let planId = provenance.planId;
  if (provenance.runId) {
    const run = readRunRecord(repositoryDir, provenance.runId);
    if (run.status !== "completed") throw new GitDeliveryError("RUN_NOT_COMPLETED", "Originating run has not completed", 409);
    conversationId = run.conversationId;
    planId = run.executionPlanId || planId;
  }
  return {
    schemaVersion: 1,
    changeSetId: changeSet.id,
    revision: changeSet.patchSha256,
    baseSha: changeSet.baseSha,
    headSha: changeSet.headSha,
    changedFiles: [...changeSet.changedFiles],
    verificationDigest: digest(changeSet.verificationEvidence),
    reviewRunIds: reviewRuns.map((run) => run.id).sort(),
    ...(runId ? { runId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(planId ? { planId } : {}),
  };
}

function normalizeInput(repositoryDir: string, raw: GitDeliveryInput): GitDeliveryInput {
  if (!raw || typeof raw !== "object") throw new GitDeliveryError("INVALID_REQUEST", "Git delivery input is required");
  switch (raw.action) {
    case "create_branch":
      return { action: raw.action, branch: validateBranch(repositoryDir, raw.branch), baseSha: validateSha(repositoryDir, raw.baseSha, "baseSha"), expectedRefSha: expectedLocalSha(repositoryDir, raw.expectedRefSha, "expectedRefSha") };
    case "commit_change_set":
      if (typeof raw.changeSetId !== "string" || !/^[a-f0-9]{64}$/.test(raw.changeSetId)) throw new GitDeliveryError("INVALID_CHANGE_SET", "Invalid changeSetId");
      return { action: raw.action, branch: validateBranch(repositoryDir, raw.branch), changeSetId: raw.changeSetId, expectedRefSha: expectedLocalSha(repositoryDir, raw.expectedRefSha, "expectedRefSha"), ...(typeof raw.subject === "string" && raw.subject.trim() ? { subject: raw.subject.trim().replace(/[\r\n]+/g, " ").slice(0, 120) } : {}) };
    case "fast_forward":
      return { action: raw.action, branch: validateBranch(repositoryDir, raw.branch), sourceSha: validateSha(repositoryDir, raw.sourceSha, "sourceSha"), expectedHeadSha: validateSha(repositoryDir, raw.expectedHeadSha, "expectedHeadSha") };
    case "rebase":
      return { action: raw.action, branch: validateBranch(repositoryDir, raw.branch), expectedHeadSha: validateSha(repositoryDir, raw.expectedHeadSha, "expectedHeadSha"), upstreamSha: validateSha(repositoryDir, raw.upstreamSha, "upstreamSha"), ontoSha: validateSha(repositoryDir, raw.ontoSha, "ontoSha") };
    case "cherry_pick":
      if (!Array.isArray(raw.commits) || !raw.commits.length || raw.commits.length > 100) throw new GitDeliveryError("INVALID_COMMITS", "commits must be a bounded non-empty array");
      return { action: raw.action, branch: validateBranch(repositoryDir, raw.branch), expectedHeadSha: validateSha(repositoryDir, raw.expectedHeadSha, "expectedHeadSha"), commits: raw.commits.map((sha) => validateSha(repositoryDir, sha, "commit")) };
    case "push":
      if (typeof raw.remote !== "string" || !REMOTE.test(raw.remote)) throw new GitDeliveryError("INVALID_REMOTE", "Invalid configured remote name");
      git(repositoryDir, ["remote", "get-url", raw.remote]);
      return { action: raw.action, remote: raw.remote, localSha: validateSha(repositoryDir, raw.localSha, "localSha"), remoteRef: validateRemoteRef(raw.remoteRef), expectedRemoteSha: expectedRemoteSha(raw.expectedRemoteSha) };
    default:
      throw new GitDeliveryError("INVALID_ACTION", "Unsupported Git delivery action");
  }
}

function exactArgs(input: GitDeliveryInput): string[] {
  switch (input.action) {
    case "create_branch": return ["update-ref", `refs/heads/${input.branch}`, input.baseSha, input.expectedRefSha || ZERO_SHA];
    case "commit_change_set": return ["commit-tree", "<verified-tree>", "-p", "<change-set-base>", "&&", "update-ref", `refs/heads/${input.branch}`, "<commit>", input.expectedRefSha || ZERO_SHA];
    case "fast_forward": return ["update-ref", `refs/heads/${input.branch}`, input.sourceSha, input.expectedHeadSha];
    case "rebase": return ["rebase", "--onto", input.ontoSha, input.upstreamSha, input.expectedHeadSha, "&&", "update-ref", `refs/heads/${input.branch}`, "<rebased-head>", input.expectedHeadSha];
    case "cherry_pick": return ["cherry-pick", ...input.commits, "&&", "update-ref", `refs/heads/${input.branch}`, "<picked-head>", input.expectedHeadSha];
    case "push": return ["push", "--porcelain", `--force-with-lease=${input.remoteRef}:${input.expectedRemoteSha || ""}`, input.remote, `${input.localSha}:${input.remoteRef}`];
  }
}

function preflight(repositoryDir: string, actor: GitDeliveryActor, input: GitDeliveryInput, provenance: GitDeliveryProvenance): GitOperationPreflight {
  const reasons = authorize(actor, input);
  const warnings: string[] = [];
  const repoId = repositoryId(repositoryDir);
  let before: Record<string, unknown> = {};
  let evidence: GitEvidenceSummary | undefined;
  if (input.action === "push") {
    before = { remote: input.remote, remoteRef: input.remoteRef, expectedRemoteSha: input.expectedRemoteSha, desiredSha: input.localSha };
  } else {
    const ref = branchRef(repositoryDir, input.branch);
    const current = refSha(repositoryDir, ref);
    before = { ref, headSha: current };
    const expected = "expectedHeadSha" in input ? input.expectedHeadSha : "expectedRefSha" in input ? input.expectedRefSha || null : null;
    if (current !== expected) reasons.push("Branch head changed from the expected revision");
    if (checkedOutBranches(repositoryDir).has(input.branch)) reasons.push("Refusing to move a branch that is checked out in a live worktree");
    if (input.action === "fast_forward" && !gitSucceeds(repositoryDir, ["merge-base", "--is-ancestor", input.expectedHeadSha, input.sourceSha])) reasons.push("Source revision is not a fast-forward of the expected branch head");
    if (input.action === "commit_change_set") {
      try {
        evidence = evidenceSummary(repositoryDir, input, provenance, actor);
        if (current && current !== evidence.baseSha) reasons.push("Delivery branch must be new or still point at the change-set base");
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : "Change-set evidence is invalid");
      }
    }
  }
  const material = { action: input.action, input, provenance, repositoryId: repoId, before, evidence };
  return { applicable: reasons.length === 0, approvalDigest: digest(material), reasons: [...new Set(reasons)], warnings, exactArgs: exactArgs(input), repositoryId: repoId, before, ...(evidence ? { evidenceSummary: evidence } : {}) };
}

function appendTrace(workspaceDir: string, store: GitDeliveryStore, operation: GitOperation, action: string, decision?: string, extra: Record<string, unknown> = {}): string {
  const event = new TraceStore(workspaceDir).append({
    kind: action.includes("approval") ? "approval" : action.includes("failed") || action.includes("conflict") ? "error" : "git",
    action,
    correlationId: operation.id,
    causationId: operation.provenance.runId,
    runId: operation.provenance.runId,
    conversationId: operation.provenance.conversationId,
    agentId: operation.actor.username,
    decision,
    metadata: redactSecrets({ operationId: operation.id, action: operation.action, status: operation.status, branch: "branch" in operation.input ? operation.input.branch : undefined, remote: operation.input.action === "push" ? operation.input.remote : undefined, remoteRef: operation.input.action === "push" ? operation.input.remoteRef : undefined, ...extra }),
  });
  store.addTrace(operation.id, event.eventId);
  return event.eventId;
}

function commitMessage(operation: GitOperation): string {
  const evidence = operation.preflight.evidenceSummary!;
  const subject = operation.input.action === "commit_change_set" && operation.input.subject
    ? operation.input.subject
    : `Deliver ${evidence.changedFiles.length} verified file${evidence.changedFiles.length === 1 ? "" : "s"}`;
  const lines = [subject, "", `ChangeSet: ${evidence.changeSetId}`, `Reviewed-Revision: ${evidence.revision}`, `Evidence-SHA256: ${evidence.verificationDigest}`];
  if (evidence.runId) lines.push(`Run: ${evidence.runId}`);
  if (evidence.planId) lines.push(`Plan: ${evidence.planId}`);
  return lines.join("\n");
}

function updateRef(repositoryDir: string, ref: string, next: string, expected: string | null): void {
  git(repositoryDir, ["update-ref", ref, next, expected || ZERO_SHA]);
}

function temporaryWorktree<T>(repositoryDir: string, startSha: string, run: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-git-delivery-"));
  let added = false;
  try {
    git(repositoryDir, ["worktree", "add", "--detach", directory, startSha]);
    added = true;
    return run(directory);
  } finally {
    if (added) {
      try { git(repositoryDir, ["worktree", "remove", "--force", directory]); }
      catch { fs.rmSync(directory, { recursive: true, force: true }); }
    } else fs.rmSync(directory, { recursive: true, force: true });
  }
}

function conflicts(directory: string): Array<Record<string, unknown>> {
  return git(directory, ["diff", "--name-only", "--diff-filter=U", "-z"], { allowFailure: true }).split("\0").filter(Boolean).map((file) => ({ path: file, kind: "content" }));
}

function remoteHead(repositoryDir: string, remote: string, ref: string): string | null {
  const output = git(repositoryDir, ["ls-remote", "--heads", remote, ref], { timeout: 60_000 });
  const sha = output.split(/\s+/)[0] || "";
  return SHA.test(sha) ? sha : null;
}

function finishConflict(workspaceDir: string, store: GitDeliveryStore, operation: GitOperation, ownerToken: string, code: string, message: string, conflicts: Array<Record<string, unknown>>): GitOperation {
  const conflicted = store.finish(operation.id, ownerToken, { status: "conflicted", conflicts, error: message });
  appendTrace(workspaceDir, store, conflicted, "Git delivery conflict", "conflicted", { code, conflicts });
  return store.get(conflicted.id);
}

function executeClaimed(workspaceDir: string, store: GitDeliveryStore, claimed: GitOperation): GitOperation {
  const repositoryDir = repository(workspaceDir);
  const ownerToken = claimed.lease!.ownerToken;
  appendTrace(workspaceDir, store, claimed, "Git delivery execution started", "running");
  const currentPreflight = preflight(repositoryDir, claimed.actor, claimed.input, claimed.provenance);
  if (!currentPreflight.applicable || currentPreflight.approvalDigest !== claimed.approval?.digest) {
    return finishConflict(workspaceDir, store, claimed, ownerToken, "STALE_PREFLIGHT", "Repository state changed after approval", [{ code: "STALE_PREFLIGHT", reasons: currentPreflight.reasons }]);
  }
  try {
    let after: Record<string, unknown>;
    if (claimed.input.action === "push") {
      const input = claimed.input;
      const observed = remoteHead(repositoryDir, input.remote, input.remoteRef);
      if (observed !== input.expectedRemoteSha) {
        return finishConflict(workspaceDir, store, claimed, ownerToken, "UPSTREAM_DRIFT", "Remote ref changed after approval", [{ code: "UPSTREAM_DRIFT", expected: input.expectedRemoteSha, observed }]);
      }
      store.checkpoint(claimed.id, ownerToken, { remoteRef: input.remoteRef, headSha: input.localSha, phase: "prepared" });
      try {
        git(repositoryDir, ["push", "--porcelain", `--force-with-lease=${input.remoteRef}:${input.expectedRemoteSha || ""}`, input.remote, `${input.localSha}:${input.remoteRef}`], { timeout: 120_000 });
      } catch (error) {
        try {
          const afterFailure = remoteHead(repositoryDir, input.remote, input.remoteRef);
          if (afterFailure === input.localSha) {
            const completed = store.finish(claimed.id, ownerToken, { status: "completed", after: { remoteRef: input.remoteRef, headSha: afterFailure } });
            appendTrace(workspaceDir, store, completed, "Git delivery completed", "completed", { remoteRef: input.remoteRef, headSha: afterFailure, recoveredAfterPushError: true });
            return store.get(completed.id);
          }
          if (afterFailure !== input.expectedRemoteSha) return finishConflict(workspaceDir, store, claimed, ownerToken, "UPSTREAM_DRIFT", "Remote ref changed during push", [{ code: "UPSTREAM_DRIFT", expected: input.expectedRemoteSha, observed: afterFailure }]);
        } catch {
          const uncertain = store.finish(claimed.id, ownerToken, { status: "manual_recovery", after: { remoteRef: input.remoteRef, headSha: input.localSha, phase: "push_outcome_unknown" }, error: "Push outcome could not be confirmed" });
          appendTrace(workspaceDir, store, uncertain, "Git delivery failed", "manual_recovery", { code: "PUSH_OUTCOME_UNKNOWN" });
          return store.get(uncertain.id);
        }
        throw error;
      }
      const pushed = remoteHead(repositoryDir, input.remote, input.remoteRef);
      if (pushed !== input.localSha) throw new GitDeliveryError("PUSH_NOT_CONFIRMED", "Remote did not confirm the desired revision");
      after = { remoteRef: input.remoteRef, headSha: pushed };
    } else {
      const input = claimed.input;
      const ref = branchRef(repositoryDir, input.branch);
      const expected = "expectedHeadSha" in input ? input.expectedHeadSha : input.expectedRefSha || null;
      let nextSha = "";
      if (input.action === "create_branch") nextSha = input.baseSha;
      else if (input.action === "fast_forward") nextSha = input.sourceSha;
      else if (input.action === "commit_change_set") {
        const changeSet = getChangeSet(repositoryDir, input.changeSetId);
        const checkout = reconstructChangeSetCheckout(repositoryDir, changeSet);
        try {
          git(checkout.checkoutDir, ["add", "-A", "--", "."]);
          const tree = git(checkout.checkoutDir, ["write-tree"]);
          nextSha = git(checkout.checkoutDir, ["commit-tree", tree, "-p", changeSet.baseSha], { input: `${commitMessage(claimed)}\n` });
        } finally { checkout.cleanup(); }
      } else if (input.action === "rebase") {
        const result = temporaryWorktree(repositoryDir, input.expectedHeadSha, (directory) => {
          try { git(directory, ["rebase", "--onto", input.ontoSha, input.upstreamSha, input.expectedHeadSha]); return { sha: git(directory, ["rev-parse", "HEAD"]) }; }
          catch (error) { const found = conflicts(directory); try { git(directory, ["rebase", "--abort"]); } catch { /* temporary worktree is discarded */ } return { error, conflicts: found }; }
        });
        if ("error" in result) {
          const message = result.error instanceof Error ? result.error.message : "Rebase conflict";
          return finishConflict(workspaceDir, store, claimed, ownerToken, "REBASE_CONFLICT", message, result.conflicts || []);
        }
        nextSha = result.sha;
      } else {
        const result = temporaryWorktree(repositoryDir, input.expectedHeadSha, (directory) => {
          try { git(directory, ["cherry-pick", "--no-gpg-sign", ...input.commits]); return { sha: git(directory, ["rev-parse", "HEAD"]) }; }
          catch (error) { const found = conflicts(directory); try { git(directory, ["cherry-pick", "--abort"]); } catch { /* temporary worktree is discarded */ } return { error, conflicts: found }; }
        });
        if ("error" in result) {
          const message = result.error instanceof Error ? result.error.message : "Cherry-pick conflict";
          return finishConflict(workspaceDir, store, claimed, ownerToken, "CHERRY_PICK_CONFLICT", message, result.conflicts || []);
        }
        nextSha = result.sha;
      }
      store.checkpoint(claimed.id, ownerToken, { ref, headSha: nextSha, phase: "prepared" });
      try { updateRef(repositoryDir, ref, nextSha, expected); }
      catch (error) {
        const observed = refSha(repositoryDir, ref);
        if (observed !== expected) return finishConflict(workspaceDir, store, claimed, ownerToken, "REF_CAS_FAILED", "Branch head changed during delivery", [{ code: "REF_CAS_FAILED", expected, observed }]);
        throw error;
      }
      after = { ref, headSha: nextSha };
    }
    const finished = store.finish(claimed.id, ownerToken, { status: "completed", after });
    appendTrace(workspaceDir, store, finished, "Git delivery completed", "completed", after);
    return store.get(finished.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git delivery failed";
    const failed = store.finish(claimed.id, ownerToken, { status: "failed", error: message });
    appendTrace(workspaceDir, store, failed, "Git delivery failed", "failed", { error: message });
    return store.get(failed.id);
  }
}

export class GitDeliveryService {
  readonly store: GitDeliveryStore;
  constructor(readonly workspaceDir: string) { this.store = new GitDeliveryStore(workspaceDir); }

  prepare(request: GitDeliveryPrepareRequest, actor: GitDeliveryActor): GitOperation {
    const repositoryDir = repository(this.workspaceDir);
    if (typeof request.idempotencyKey !== "string" || !request.idempotencyKey.trim() || request.idempotencyKey.length > 200) throw new GitDeliveryError("INVALID_IDEMPOTENCY_KEY", "A bounded Idempotency-Key is required");
    const input = normalizeInput(repositoryDir, request.input);
    const provenance = validateProvenance(repositoryDir, request.provenance || {}, input);
    const prepared = preflight(repositoryDir, actor, input, provenance);
    if (!prepared.applicable) throw new GitDeliveryError("PREFLIGHT_FAILED", prepared.reasons.join("; "), 409);
    const requestDigest = digest({ input, provenance, actor: actor.username });
    const now = Date.now();
    const operation: GitOperation = { schemaVersion: 1, id: crypto.randomUUID(), version: 1, idempotencyKeyHash: digest(`${actor.username}\0${request.idempotencyKey.trim()}`), requestDigest, action: input.action, risk: ["rebase", "cherry_pick", "push"].includes(input.action) ? "high" : "medium", status: "awaiting_approval", actor, input, provenance, preflight: prepared, before: prepared.before, traceEventIds: [], createdAt: now, updatedAt: now };
    const created = this.store.create(operation);
    if (created.traceEventIds.length === 0) appendTrace(this.workspaceDir, this.store, created, "Git delivery prepared", "awaiting_approval", { approvalDigest: prepared.approvalDigest });
    return this.store.get(created.id);
  }

  list(): GitOperation[] { this.reconcile(); return this.store.list(); }
  get(id: string): GitOperation { this.reconcile(); return this.store.get(id); }

  approve(id: string, expectedVersion: number, approvalDigest: string, actor: GitDeliveryActor, reason?: string): GitOperation {
    const current = this.store.get(id);
    if (current.actor.username !== actor.username && !actor.isAdmin && actor.teamRole !== "owner" && actor.teamRole !== "admin") throw new GitDeliveryError("FORBIDDEN", "Only the requester or a workspace manager can approve this operation", 403);
    const branch = "branch" in current.input ? current.input.branch : current.input.action === "push" ? current.input.remoteRef.slice("refs/heads/".length) : "";
    if (protectedBranch(branch) && !reason?.trim()) throw new GitDeliveryError("APPROVAL_REASON_REQUIRED", "Protected branch approval requires a reason");
    try {
      const approved = this.store.approve(id, expectedVersion, approvalDigest, actor.username, reason);
      appendTrace(this.workspaceDir, this.store, approved, "Git delivery approval granted", "approved");
      return executeClaimed(this.workspaceDir, this.store, this.store.claim(id));
    } catch (error) {
      if (error instanceof GitOperationVersionConflictError) throw new GitDeliveryError("VERSION_CONFLICT", error.message, 409, error.current);
      throw error;
    }
  }

  cancel(id: string, expectedVersion: number, actor: GitDeliveryActor): GitOperation {
    const current = this.store.get(id);
    if (current.actor.username !== actor.username && !actor.isAdmin && actor.teamRole !== "owner" && actor.teamRole !== "admin") throw new GitDeliveryError("FORBIDDEN", "Only the requester or a workspace manager can cancel this operation", 403);
    try {
      const cancelled = this.store.cancel(id, expectedVersion);
      appendTrace(this.workspaceDir, this.store, cancelled, "Git delivery cancelled", "cancelled");
      return this.store.get(id);
    } catch (error) {
      if (error instanceof GitOperationVersionConflictError) throw new GitDeliveryError("VERSION_CONFLICT", error.message, 409, error.current);
      throw error;
    }
  }

  reconcile(): GitOperation[] {
    const repositoryDir = repository(this.workspaceDir);
    const before = new Map(this.store.list().map((operation) => [operation.id, operation]));
    const reconciled = this.store.reconcileRunning((operation) => {
      if (TERMINAL.has(operation.status)) return { status: "manual_recovery", error: "Unexpected terminal operation lease" };
      const intended = typeof operation.after?.headSha === "string" ? operation.after.headSha : operation.input.action === "push" ? operation.input.localSha : undefined;
      if (!intended) return { status: "manual_recovery", error: "Interrupted operation has no durable intended revision" };
      if (operation.input.action === "push") {
        const observed = remoteHead(repositoryDir, operation.input.remote, operation.input.remoteRef);
        if (observed === intended) return { status: "completed", after: { remoteRef: operation.input.remoteRef, headSha: observed } };
        if (observed === operation.input.expectedRemoteSha) return { status: "queued", error: "Recovered before remote mutation" };
        return { status: "manual_recovery", error: "Remote ref diverged while recovering an interrupted push" };
      }
      const ref = branchRef(repositoryDir, operation.input.branch);
      const observed = refSha(repositoryDir, ref);
      const before = typeof operation.before.headSha === "string" ? operation.before.headSha : null;
      if (observed === intended) return { status: "completed", after: { ref, headSha: observed } };
      if (observed === before) return { status: "queued", error: "Recovered before local ref mutation" };
      return { status: "manual_recovery", error: "Local ref diverged while recovering an interrupted operation" };
    });
    for (const operation of reconciled) {
      if (before.get(operation.id)?.status === "running" && operation.status !== "running") appendTrace(this.workspaceDir, this.store, operation, "Git delivery recovery reconciled", operation.status, { recoveryStatus: operation.status });
    }
    for (const operation of this.store.list()) {
      if (operation.status === "queued" && operation.approval) {
        try { executeClaimed(this.workspaceDir, this.store, this.store.claim(operation.id)); }
        catch (error) {
          const current = this.store.get(operation.id);
          if (current.status === "queued") continue;
          if (current.status === "running" && current.lease) {
            const failed = this.store.finish(current.id, current.lease.ownerToken, { status: "failed", error: error instanceof Error ? error.message : "Recovery execution failed" });
            appendTrace(this.workspaceDir, this.store, failed, "Git delivery failed", "failed", { recovery: true });
          }
        }
      }
    }
    return this.store.list();
  }
}
