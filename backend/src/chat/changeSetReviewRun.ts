import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { resolveAgentProfile } from "../agent/agentProfiles.js";
import { processModelTurn } from "../agent/modelProcessor.js";
import type { OpenAIMessage } from "../agent/types.js";
import { getAllTools } from "../agent/tools.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import { readAuthorizedWorkspaceFile } from "../agent/contextPolicy.js";
import { changeSetReviewRevision, getChangeSet, type ChangeSet } from "./changeSets.js";
import { CURRENT_CHANGE_SET_SCHEMA_VERSION } from "./changeSetSchema.js";
import { ReviewFindingStore, type StoredReviewFinding } from "./reviewFindingStore.js";
import { normalizeReviewFinding } from "./reviewFindings.js";
import { bindConfiguredFallbacks, buildProviderExecutionContract } from "../agent/providerRouting.js";
import { isProcessAlive } from "../utils/processLiveness.js";

export type ChangeSetReviewStage = "review" | "reverify";
export type ChangeSetReviewRunStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export interface ChangeSetReviewRun {
  schemaVersion: 1; id: string; changeSetId: string; revision: string; baseSha: string; stage: ChangeSetReviewStage;
  attempt: number; status: ChangeSetReviewRunStatus; requestedBy: string; reviewer: { id: string; modelName: string; profile: "change_set_reviewer" }; verifier?: { id: string; modelName: string; profile: "change_set_verifier" };
  checkoutDigest: string; createdAt: string; startedAt?: string; completedAt?: string; error?: string; findingIds: string[];
  ownerPid: number; ownerToken: string; heartbeatAt: number; leaseExpiresAt: number; retryOf?: string;
  verificationResults?: ChangeSetVerificationResult[];
}
export interface ChangeSetVerificationResult { findingId: string; fingerprint: string; status: "verified" | "reproduced"; revision: string; reviewRunId: string; evidence: string[]; verifier: { id: string; modelName: string; profile: "change_set_verifier" }; }
export interface ChangeSetReviewRunnerInput { auditWorkspaceDir: string; checkoutDir: string; reviewRunId: string; changeSet: ChangeSet; stage: ChangeSetReviewStage; actor: { id: string; modelName: string; profile: "change_set_reviewer" | "change_set_verifier" }; fixedFindings?: Array<Pick<StoredReviewFinding, "id" | "fingerprint" | "path" | "line" | "column" | "message">>; }
export type ChangeSetReviewRunner = (input: ChangeSetReviewRunnerInput) => Promise<unknown[]>;
const RUN_LEASE_MS = 60_000;
export class ChangeSetReviewPersistenceError extends Error { readonly code = "change_set_review_persistence_invalid"; constructor(readonly filePath: string, cause?: unknown) { super(`Change set review persistence is invalid or unreadable: ${path.basename(filePath)}`, { cause }); } }
const ACTIVE_RUNS = new Set<string>();
const processAlive = isProcessAlive;
function ownership() { const now = Date.now(); return { ownerPid: process.pid, ownerToken: crypto.randomUUID(), heartbeatAt: now, leaseExpiresAt: now + RUN_LEASE_MS }; }

function git(dir: string, args: string[]): string { try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (error) { throw new Error((error as { stderr?: Buffer }).stderr?.toString().trim() || (error instanceof Error ? error.message : "git failed")); } }
function root(dir: string) { return path.resolve(git(dir, ["rev-parse", "--show-toplevel"])); }
function runFile(repository: string) { return path.join(repository, ".history", "change-set-review-runs.json"); }
function readRuns(repository: string): ChangeSetReviewRun[] { const file = runFile(repository); try { const value = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(value) || !value.every((x): x is ChangeSetReviewRun => x && x.schemaVersion === 1 && typeof x.id === "string")) throw new ChangeSetReviewPersistenceError(file); return value; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; if (error instanceof ChangeSetReviewPersistenceError) throw error; throw new ChangeSetReviewPersistenceError(file, error); } }
function writeRuns(repository: string, runs: ChangeSetReviewRun[]) { const file = runFile(repository); fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(redactSecrets(runs), null, 2) + "\n", "utf8"); fs.renameSync(temp, file); }
function withRunLock<T>(repository: string, operation: () => T): T { const file = `${runFile(repository)}.lock`; fs.mkdirSync(path.dirname(file), { recursive: true }); const token = crypto.randomUUID(); let fd: number | undefined; for (let attempt = 0; attempt < 200; attempt += 1) { try { fd = fs.openSync(file, "wx"); fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })); break; } catch { try { const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; createdAt?: number }; if (owner.pid && !isProcessAlive(owner.pid) && Date.now() - (owner.createdAt || 0) > 1_000) fs.rmSync(file, { force: true }); } catch { /* malformed lock fails closed until stale */ try { if (Date.now() - fs.statSync(file).mtimeMs > 60_000) fs.rmSync(file, { force: true }); } catch { /* retry */ } } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } } if (fd === undefined) throw new Error("Change set review store is busy"); try { return operation(); } finally { fs.closeSync(fd); try { const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: string }; if (owner.token === token) fs.rmSync(file, { force: true }); } catch { /* ownership changed */ } } }
function digest(dir: string) { const entries: string[] = []; const visit = (current: string, relative = "") => { for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name === ".git") continue; const target = path.join(current, entry.name); const name = relative ? `${relative}/${entry.name}` : entry.name; if (entry.isDirectory()) visit(target, name); else if (entry.isFile() && !entry.isSymbolicLink()) entries.push(`${name}\0${crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`); else throw new Error(`Unsafe review checkout entry: ${name}`); } }; visit(dir); return crypto.createHash("sha256").update(entries.join("\n")).digest("hex"); }
function patch(repository: string, changeSet: ChangeSet): Buffer { if (changeSet.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION || !changeSet.patchBlob || changeSet.patchManifest?.length !== 1) throw new Error("Legacy change set cannot be independently reviewed"); const file = path.resolve(repository, ".history", "change-sets", changeSet.patchBlob); const blobs = path.resolve(repository, ".history", "change-sets", "blobs") + path.sep; if (!file.startsWith(blobs) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("Invalid persisted patch blob"); const content = fs.readFileSync(file); if (crypto.createHash("sha256").update(content).digest("hex") !== changeSet.patchSha256 || changeSet.patchManifest[0].sha256 !== changeSet.patchSha256) throw new Error("Persisted change set patch digest mismatch"); const names = git(repository, ["apply", "--numstat", "-z", file]).split("\0").filter(Boolean).map((row) => row.slice(row.lastIndexOf("\t") + 1)).sort(); const declared = [...changeSet.changedFiles].sort(); if (!names.length || JSON.stringify(names) !== JSON.stringify(declared)) throw new Error("Persisted patch scope does not match change set metadata"); return content; }
export function reconstructChangeSetCheckout(workspaceDir: string, changeSetOrId: ChangeSet | string): { checkoutDir: string; cleanup: () => void; digest: string } {
  const repository = root(workspaceDir); const changeSet = typeof changeSetOrId === "string" ? getChangeSet(repository, changeSetOrId) : changeSetOrId; const content = patch(repository, changeSet);
  const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-independent-review-")); const patchFile = path.join(checkoutDir, "change.patch");
  try { git(repository, ["worktree", "add", "--detach", checkoutDir, changeSet.baseSha]); fs.writeFileSync(patchFile, content, { flag: "wx" }); git(checkoutDir, ["apply", "--check", "--binary", patchFile]); git(checkoutDir, ["apply", "--binary", patchFile]); fs.rmSync(patchFile, { force: true }); const current = digest(checkoutDir); return { checkoutDir, digest: current, cleanup: () => { try { git(repository, ["worktree", "remove", "--force", checkoutDir]); } catch { fs.rmSync(checkoutDir, { recursive: true, force: true }); } } }; } catch (error) { try { git(repository, ["worktree", "remove", "--force", checkoutDir]); } catch { fs.rmSync(checkoutDir, { recursive: true, force: true }); } throw error; }
}
/** Production runner calls the configured provider; tests replace this deterministic boundary. */
async function productionRunner(input: ChangeSetReviewRunnerInput): Promise<unknown[]> {
  const profile = resolveAgentProfile(input.actor.profile, config.agentProfiles, { modelName: config.modelName, maxOutputTokens: config.agentMaxTokens });
  const tools = getAllTools({ readOnly: true, mode: "review" }).filter((tool) => ["read_file", "bash", "report_review_finding"].includes(tool.function.name));
  const fixed = input.stage === "reverify" ? `\nPreviously fixed findings to reproduce or disprove:\n${JSON.stringify(input.fixedFindings || [])}\nReport every reproduced finding with the same path, location, message and direct evidence. Emit no finding for a candidate only when independent inspection does not reproduce it.` : "";
  const revision = changeSetReviewRevision(input.changeSet);
  const messages: OpenAIMessage[] = [{ role: "user", content: `Independently ${input.stage === "review" ? "review" : "verify fixed findings for"} immutable revision ${revision}. You are in a fresh read-only checkout. Inspect only; network and writes are denied. Use read_file or read-only git bash commands as needed. Return findings only through report_review_finding, with reviewedRevision exactly ${revision}.${fixed}` }];
  const findings: unknown[] = [];
  const executionContract = buildProviderExecutionContract({ id: `${profile.id}:immutable-review`, permissions: profile.permissions.allow, isolation: `review_checkout:${input.reviewRunId}`, tools: tools.map((tool) => tool.function.name) });
  for (let step = 0; step < Math.min(12, profile.budget.maxSteps); step += 1) {
    const result = await processModelTurn({ apiUrl: config.vllmApiUrl, apiKey: config.vllmApiKey, model: profile.modelName || config.modelName, providerId: profile.providerId, messages, tools, executionContract, fallbacks: bindConfiguredFallbacks(config.modelFallbacks, executionContract, profile.budget.maxOutputTokens), fallbackMaxOutputTokens: profile.budget.maxOutputTokens, temperature: 0, contextAudit: { storeWorkspaceDir: input.auditWorkspaceDir, effectiveWorkspaceDir: input.checkoutDir, scope: { kind: "review_checkout", scopeId: input.reviewRunId, baseSha: input.changeSet.baseSha, headSha: revision }, purpose: "change_set_review", runId: input.reviewRunId, requestId: input.reviewRunId, agentId: input.actor.id, messageSources: [{ kind: "review_instruction", sourceType: "immutable_change_set", reason: "Independent review of an integrity-bound revision", revision, trust: "approved_user_artifact", integrity: "verified_digest", freshness: "fresh" }] } });
    const message = result.response.choices[0]?.message; const calls = message?.tool_calls || [];
    messages.push({ role: "assistant", content: message?.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) break;
    for (const call of calls.slice(0, profile.budget.maxToolCalls)) {
      let args: Record<string, unknown> = {}; try { args = JSON.parse(call.function.arguments); } catch { /* return a bounded tool error */ }
      if (call.function.name === "report_review_finding") { findings.push(args); messages.push({ role: "tool", tool_call_id: call.id, content: "Finding accepted for server validation." }); continue; }
      const output = call.function.name === "read_file" ? readOnlyFile(input.checkoutDir, args.path) : call.function.name === "bash" ? readOnlyGit(input.checkoutDir, args.command) : "Error: tool is not available to independent review";
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
  return findings;
}
function readOnlyFile(checkoutDir: string, raw: unknown): string { try { if (typeof raw !== "string") return "Error: path is required"; return readAuthorizedWorkspaceFile(checkoutDir, raw).content.slice(0, 50_000); } catch (error) { return `Error: ${error instanceof Error ? error.message : "read failed"}`; } }
function readOnlyGit(checkoutDir: string, raw: unknown): string { if (typeof raw !== "string" || /[;&|`$><\\]/.test(raw) || !/^git\s+(?:diff|show|status|log|rev-parse)\b/.test(raw.trim())) return "Error: independent review bash accepts only read-only git commands"; const parts = raw.trim().split(/\s+/); const args = parts.slice(1); if (args.some((arg) => arg === "--no-index" || arg === "--ext-diff" || arg === "--textconv" || arg.startsWith("--output") || arg.startsWith("--config") || arg.startsWith("-c") || path.isAbsolute(arg) || arg === ".." || arg.startsWith("../"))) return "Error: unsafe git argument denied"; try { return execFileSync("git", ["-C", checkoutDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: checkoutDir, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } }).slice(0, 50_000); } catch (error) { return `Error: ${(error as { stderr?: Buffer }).stderr?.toString().slice(0, 1000) || "git command failed"}`; } }
let runner: ChangeSetReviewRunner = productionRunner;
export function setChangeSetReviewRunnerForTests(value?: ChangeSetReviewRunner) { runner = value || productionRunner; }
function persistDispatchFailure(repository: string, id: string, error: unknown): void { try { withRunLock(repository, () => { const runs = readRuns(repository); const run = runs.find((item) => item.id === id); if (!run || (run.status !== "queued" && run.status !== "running") || run.ownerPid !== process.pid) return; run.status = "failed"; run.completedAt = new Date().toISOString(); run.error = redactSecrets(`Review run dispatch failed: ${error instanceof Error ? error.message : "unknown error"}`).slice(0, 1000); writeRuns(repository, runs); }); } catch { /* later startup reconciliation will recover the durable lease */ } }
function dispatchRun(repository: string, id: string): void { if (ACTIVE_RUNS.has(id)) return; ACTIVE_RUNS.add(id); void Promise.resolve().then(() => executeChangeSetReview(repository, id)).catch((error) => { ACTIVE_RUNS.delete(id); persistDispatchFailure(repository, id, error); }); }
export function reconcileChangeSetReviewRuns(workspaceDir: string): ChangeSetReviewRun[] { const repository = root(workspaceDir); const enqueue: string[] = []; const reconciled = withRunLock(repository, () => { const runs = readRuns(repository); let changed = false; const now = Date.now(); for (const run of [...runs]) { if (run.status !== "queued" && run.status !== "running") continue; if (ACTIVE_RUNS.has(run.id)) continue; const alive = Number.isSafeInteger(run.ownerPid) && processAlive(run.ownerPid); const leaseCurrent = typeof run.leaseExpiresAt === "number" && run.leaseExpiresAt > now; if (alive && leaseCurrent) continue; if (run.status === "running") { run.status = "interrupted"; run.completedAt = new Date(now).toISOString(); run.error = "Review run interrupted after its owner lease expired"; const attempt = runs.filter((item) => item.changeSetId === run.changeSetId && item.revision === run.revision && item.stage === run.stage).length + 1; const retry: ChangeSetReviewRun = { ...run, ...ownership(), id: crypto.randomUUID(), attempt, status: "queued", retryOf: run.id, checkoutDigest: "", createdAt: new Date(now).toISOString(), startedAt: undefined, completedAt: undefined, error: undefined, findingIds: [], verificationResults: [] }; runs.push(retry); enqueue.push(retry.id); changed = true; } else { Object.assign(run, ownership()); enqueue.push(run.id); changed = true; } } if (changed) writeRuns(repository, runs); return runs; }); for (const id of enqueue) dispatchRun(repository, id); return reconciled; }
export function listChangeSetReviewRuns(workspaceDir: string, changeSetId?: string): ChangeSetReviewRun[] { const repository = root(workspaceDir); const runs = reconcileChangeSetReviewRuns(repository); return runs.filter((run) => !changeSetId || run.changeSetId === changeSetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export function hasCompletedChangeSetReview(workspaceDir: string, changeSetId: string, revision: string): boolean { return listChangeSetReviewRuns(workspaceDir, changeSetId).some((run) => run.stage === "review" && run.status === "completed" && run.revision === revision); }
function fixedCandidates(store: ReviewFindingStore, changeSet: ChangeSet): StoredReviewFinding[] {
  const revision = changeSetReviewRevision(changeSet);
  return store.list().filter((item) => item.lifecycle === "fixed" && (item.fixRef === changeSet.id || item.fixRef === revision) && item.reviewer?.revision !== revision && item.reviewer?.changeSetId !== changeSet.id);
}

export function scheduleChangeSetReview(workspaceDir: string, changeSetId: string, requestedBy: string, stage: ChangeSetReviewStage = "review"): ChangeSetReviewRun {
  const repository = root(workspaceDir); const changeSet = getChangeSet(repository, changeSetId);
  if (changeSet.schemaVersion !== CURRENT_CHANGE_SET_SCHEMA_VERSION || !changeSet.patchBlob) throw new Error("Legacy change set cannot be independently reviewed");
  const revision = changeSetReviewRevision(changeSet);
  if (stage === "reverify") {
    if (!hasCompletedChangeSetReview(repository, changeSet.id, revision)) throw new Error("Current revision has not completed independent review");
    if (!fixedCandidates(new ReviewFindingStore(repository), changeSet).length) throw new Error("Reverification requires a fixed finding bound to this new immutable revision");
  }
  reconcileChangeSetReviewRuns(repository);
  const run = withRunLock(repository, () => {
    const runs = readRuns(repository); const existing = runs.find((x) => x.changeSetId === changeSet.id && x.revision === revision && x.stage === stage && ["queued", "running"].includes(x.status)); if (existing) return existing;
    const attempt = runs.filter((x) => x.changeSetId === changeSet.id && x.revision === revision && x.stage === stage).length + 1;
    const profileId = stage === "review" ? "change_set_reviewer" : "change_set_verifier"; const modelName = resolveAgentProfile(profileId, config.agentProfiles, { modelName: config.modelName }).modelName || config.modelName;
    const created: ChangeSetReviewRun = { schemaVersion: 1, id: crypto.randomUUID(), changeSetId: changeSet.id, revision, baseSha: changeSet.baseSha, stage, attempt, status: "queued", requestedBy: requestedBy.slice(0, 160), reviewer: { id: `change_set_reviewer:${crypto.randomUUID()}`, modelName: resolveAgentProfile("change_set_reviewer", config.agentProfiles, { modelName: config.modelName }).modelName || config.modelName, profile: "change_set_reviewer" }, ...(stage === "reverify" ? { verifier: { id: `change_set_verifier:${crypto.randomUUID()}`, modelName, profile: "change_set_verifier" as const }, verificationResults: [] } : {}), checkoutDigest: "", createdAt: new Date().toISOString(), findingIds: [], ...ownership() };
    runs.push(created); writeRuns(repository, runs); return created;
  });
  if (run.status === "queued") dispatchRun(repository, run.id); return run;
}

async function executeChangeSetReview(repository: string, runId: string): Promise<void> {
  const run = withRunLock(repository, () => { const all = readRuns(repository); const current = all.find((x) => x.id === runId); if (!current || current.status !== "queued") return undefined; const now = Date.now(); current.status = "running"; current.startedAt = new Date(now).toISOString(); current.heartbeatAt = now; current.leaseExpiresAt = now + RUN_LEASE_MS; writeRuns(repository, all); return { ...current }; });
  if (!run) { ACTIVE_RUNS.delete(runId); return; }
  const heartbeat = setInterval(() => { try { withRunLock(repository, () => { const all = readRuns(repository); const current = all.find((item) => item.id === run.id); if (!current || current.status !== "running" || current.ownerToken !== run.ownerToken) return; const now = Date.now(); current.heartbeatAt = now; current.leaseExpiresAt = now + RUN_LEASE_MS; writeRuns(repository, all); }); } catch { /* reconciliation recovers expired ownership */ } }, Math.floor(RUN_LEASE_MS / 3)); heartbeat.unref();
  let checkout: ReturnType<typeof reconstructChangeSetCheckout> | undefined;
  try {
    const changeSet = getChangeSet(repository, run.changeSetId); if (changeSetReviewRevision(changeSet) !== run.revision) throw new Error("Change set revision is stale");
    const store = new ReviewFindingStore(repository); const candidates = run.stage === "reverify" ? fixedCandidates(store, changeSet) : [];
    if (run.stage === "reverify" && !candidates.length) throw new Error("Reverification lost its fixed finding binding");
    checkout = reconstructChangeSetCheckout(repository, changeSet); run.checkoutDigest = checkout.digest; const actor = run.stage === "review" ? run.reviewer : run.verifier!;
    const raw = await runner({ auditWorkspaceDir: repository, checkoutDir: checkout.checkoutDir, reviewRunId: run.id, changeSet, stage: run.stage, actor, ...(candidates.length ? { fixedFindings: candidates.map(({ id, fingerprint, path: findingPath, line, column, message }) => ({ id, fingerprint, path: findingPath, line, ...(column ? { column } : {}), message })) } : {}) });
    if (digest(checkout.checkoutDir) !== run.checkoutDigest) throw new Error("Independent reviewer modified its managed checkout");
    const findings = raw.flatMap((value) => { const finding = normalizeReviewFinding({ ...(value as object), reviewedRevision: run.revision }); return finding ? [finding] : []; });
    if (run.stage === "review") {
      for (const finding of findings) { const saved = store.ingest(finding, { id: run.reviewer.id, modelName: run.reviewer.modelName, profile: run.reviewer.profile, revision: run.revision, changeSetId: run.changeSetId, reviewRunId: run.id }); if (saved) run.findingIds.push(saved.id); }
    } else {
      const verifier = run.verifier!;
      run.verificationResults = [];
      const reproduced = new Set<string>();
      for (const finding of findings) {
        const candidate = candidates.find((item) => item.fingerprint === finding.fingerprint);
        const saved = store.ingest(finding, { id: verifier.id, modelName: verifier.modelName, profile: verifier.profile, revision: run.revision, changeSetId: run.changeSetId, reviewRunId: run.id }); if (saved) run.findingIds.push(saved.id);
        if (!candidate) continue;
        reproduced.add(candidate.id); const evidence = finding.evidence.map((item) => redactSecrets(item));
        store.transition(candidate.id, "open", { id: verifier.id, modelName: verifier.modelName, profile: verifier.profile, revision: run.revision, changeSetId: run.changeSetId, reviewRunId: run.id }, { evidence, reason: "Independent reverify reproduced the finding on the proposed fix revision", revision: run.revision, internalReviewRun: true, expectedVersion: candidate.version });
        run.findingIds.push(candidate.id); run.verificationResults.push({ findingId: candidate.id, fingerprint: candidate.fingerprint, status: "reproduced", revision: run.revision, reviewRunId: run.id, evidence, verifier });
      }
      for (const candidate of candidates.filter((item) => !reproduced.has(item.id))) {
        const evidence = [JSON.stringify({ kind: "independent_non_reproduction", findingId: candidate.id, fingerprint: candidate.fingerprint, reviewRunId: run.id, revision: run.revision, checkoutDigest: run.checkoutDigest })];
        store.transition(candidate.id, "verified", { id: verifier.id, modelName: verifier.modelName, profile: verifier.profile, revision: run.revision, changeSetId: run.changeSetId, reviewRunId: run.id }, { evidence, revision: run.revision, internalReviewRun: true, expectedVersion: candidate.version });
        run.findingIds.push(candidate.id); run.verificationResults.push({ findingId: candidate.id, fingerprint: candidate.fingerprint, status: "verified", revision: run.revision, reviewRunId: run.id, evidence, verifier });
      }
    }
    run.findingIds = [...new Set(run.findingIds)]; run.status = "completed"; run.completedAt = new Date().toISOString();
  } catch (error) { run.status = "failed"; run.completedAt = new Date().toISOString(); run.error = redactSecrets(error instanceof Error ? error.message : "Review run failed").slice(0, 1000); }
  finally { clearInterval(heartbeat); checkout?.cleanup(); withRunLock(repository, () => { const all = readRuns(repository); const index = all.findIndex((item) => item.id === runId); if (index >= 0 && all[index].status === "running" && all[index].ownerToken === run.ownerToken) { all[index] = run; writeRuns(repository, all); } }); ACTIVE_RUNS.delete(runId); }
}
