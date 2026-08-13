import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "../agent/secretRedaction.js";
import { readContextManifest } from "../agent/contextManifestStore.js";
import { changeSetReviewRevision, getChangeSet, readChangeSetPatch, type ChangeSet } from "../chat/changeSets.js";
import { readExecutionPlan } from "../chat/executionPlans.js";
import { readRunRecord, type AgentRunRecord } from "../chat/runHistory.js";
import { TraceStore } from "../chat/traceStore.js";
import { buildReviewArtifact, canonicalJson, sha256, type ReviewArtifactScopeV1, type ReviewArtifactV1 } from "./reviewArtifact.js";

export const EVIDENCE_BUNDLE_MEDIA_TYPE = "application/vnd.crewforge.evidence-bundle.v1+json";
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_PAYLOAD_BYTES = 24 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 256;

export type EvidenceBundleRole = "patch" | "change_set" | "plan" | "run" | "worktree" | "completion_evidence" | "review" | "trace" | "context_manifest" | "test_output";
export interface EvidenceBundleEntryDescriptorV1 { path: string; mediaType: string; role: EvidenceBundleRole; bytes: number; sha256: string; }
export interface EvidenceBundleManifestV1 {
  schemaVersion: 1;
  kind: "crewforge.evidence-bundle-manifest";
  digestAlgorithm: "sha256";
  payloadDigest: `sha256:${string}`;
  bindings: ReviewArtifactScopeV1;
  entries: EvidenceBundleEntryDescriptorV1[];
  signature: { required: boolean; format: "dsse"; payloadType: "application/vnd.crewforge.bundle-manifest.v1+json" };
}
export interface EvidenceBundleEntryV1 extends EvidenceBundleEntryDescriptorV1 { kind: "file"; encoding: "base64"; content: string; }
export interface EvidenceBundleSignatureV1 { format: "dsse"; keyId: string; envelope: string; }
export interface EvidenceBundleV1 {
  schemaVersion: 1;
  kind: "crewforge.evidence-bundle";
  manifest: EvidenceBundleManifestV1;
  entries: EvidenceBundleEntryV1[];
  signatures: EvidenceBundleSignatureV1[];
}
export interface EvidenceBundleVerification {
  bundleId?: string;
  integrity: "verified" | "failed";
  authenticity: "unsigned" | "verified" | "untrusted" | "invalid";
  bindings: "verified" | "failed";
  applicability: { baseAvailable: boolean; patchApplies: boolean; changedFilesMatch: boolean };
  issues: Array<{ code: string; message: string }>;
}

function repositoryRoot(dir: string): string {
  return path.resolve(execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
}
function safeText(workspaceDir: string, value: unknown, max = 4_000): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const root = path.resolve(workspaceDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return redactSecrets(value).replace(new RegExp(root, "g"), "[WORKSPACE]").replace(/(^|[\s"'=])\/(?!\/)[^\s"']+/g, "$1[ABS_PATH]").replace(/(^|[\s"'=])[A-Za-z]:\\[^\s"']+/g, "$1[ABS_PATH]").trim().slice(0, max);
}
function safeUnknown(workspaceDir: string, value: unknown): unknown {
  if (typeof value === "string") return safeText(workspaceDir, value) || "";
  if (Array.isArray(value)) return value.map((item) => safeUnknown(workspaceDir, item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => /(thinking|reasoning|chain.?of.?thought|prompt|raw_?output|ownerToken|leaseExpiresAt|heartbeatAt|ownerPid)/i.test(key) ? [] : [[key, safeUnknown(workspaceDir, child)]]));
}
function jsonBuffer(value: unknown): Buffer { return Buffer.from(canonicalJson(value), "utf8"); }
function entry(entryPath: string, mediaType: string, role: EvidenceBundleRole, content: Buffer): EvidenceBundleEntryV1 {
  return { path: entryPath, mediaType, role, bytes: content.byteLength, sha256: sha256(content), kind: "file", encoding: "base64", content: content.toString("base64") };
}
function descriptor(value: EvidenceBundleEntryV1): EvidenceBundleEntryDescriptorV1 { return { path: value.path, mediaType: value.mediaType, role: value.role, bytes: value.bytes, sha256: value.sha256 }; }
function changeSetProjection(changeSet: ChangeSet): Record<string, unknown> {
  return { schemaVersion: changeSet.schemaVersion, id: changeSet.id, worktreeId: changeSet.worktreeId, baseSha: changeSet.baseSha, branch: changeSet.branch, headSha: changeSet.headSha, dirty: changeSet.dirty, changedFiles: [...changeSet.changedFiles].sort(), patchSha256: changeSet.patchSha256, patchBlob: changeSet.patchBlob, patchManifest: changeSet.patchManifest, status: changeSet.status, ownerId: changeSet.ownerId, parentRunId: changeSet.parentRunId, parentTaskId: changeSet.parentTaskId, childRunId: changeSet.childRunId, toolCallId: changeSet.toolCallId, agentName: changeSet.agentName, memberName: changeSet.memberName, createdAt: changeSet.createdAt, reviewedAt: changeSet.reviewedAt, appliedAt: changeSet.appliedAt, failedAt: changeSet.failedAt, decision: changeSet.decision, decisionActorId: changeSet.decisionActorId, decisionActorIsAdmin: changeSet.decisionActorIsAdmin, captureIntegritySha256: changeSet.captureIntegritySha256, transitionVersion: changeSet.transitionVersion, transitionIntegritySha256: changeSet.transitionIntegritySha256 };
}
function runProjection(workspaceDir: string, run: AgentRunRecord): Record<string, unknown> {
  return safeUnknown(workspaceDir, { schemaVersion: run.schemaVersion, runId: run.runId, conversationId: run.conversationId, mode: run.mode, modelName: run.modelName, status: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt, endedAt: run.endedAt, resumedFromRunId: run.resumedFromRunId, parentRunId: run.parentRunId, parentTaskId: run.parentTaskId, parentToolCallId: run.parentToolCallId, parentRequestId: run.parentRequestId, agentName: run.agentName, executionPlanId: run.executionPlanId, executionContractKind: run.executionContractKind, completionEvidence: run.completionEvidence, metrics: run.metrics, contextManifestIds: [...run.contextManifestIds].sort() }) as Record<string, unknown>;
}
function contextProjection(workspaceDir: string, id: string): Record<string, unknown> {
  const value = readContextManifest(workspaceDir, id);
  return safeUnknown(workspaceDir, { schemaVersion: value.schemaVersion, manifestId: value.manifestId, logicalRequestId: value.logicalRequestId, createdAt: value.createdAt, updatedAt: value.updatedAt, status: value.status, purpose: value.purpose, runId: value.runId, conversationId: value.conversationId, requestId: value.requestId, agentId: value.agentId, providerId: value.providerId, modelName: value.modelName, scope: { kind: value.scope.kind, worktreeId: value.scope.worktreeId, baseSha: value.scope.baseSha, headSha: value.scope.headSha, indexGeneration: value.scope.indexGeneration }, policyVersion: value.policyVersion, controlsVersion: value.controlsVersion, payloadDigest: value.payloadDigest, items: value.items, estimatedPromptTokens: value.estimatedPromptTokens, actualPromptTokens: value.actualPromptTokens, excludedCount: value.excludedCount, redactedCount: value.redactedCount, truncatedCount: value.truncatedCount, attempts: value.attempts, errorCode: value.errorCode }) as Record<string, unknown>;
}

export function createEvidenceBundle(workspaceDir: string, changeSetId: string, expectedRevision?: string, options: { includeTrace?: boolean; includeTestOutput?: boolean; requireSignature?: boolean } = {}): Buffer {
  const repository = repositoryRoot(workspaceDir); const changeSet = getChangeSet(repository, changeSetId);
  const revision = changeSetReviewRevision(changeSet); if (expectedRevision && expectedRevision !== revision) throw new Error("Change set revision is stale");
  const artifact = buildReviewArtifact(repository, changeSet.id, revision);
  const run = readRunRecord(repository, artifact.scope.childRunId);
  const patchBytes = readChangeSetPatch(repository, changeSet.id);
  if (redactSecrets(patchBytes.toString("utf8")) !== patchBytes.toString("utf8")) throw new Error("Refusing to export a patch containing recognizable secret material");
  const entries: EvidenceBundleEntryV1[] = [
    entry("payload/change.patch", "text/x-diff", "patch", patchBytes),
    entry("payload/change-set.json", "application/json", "change_set", jsonBuffer(safeUnknown(repository, changeSetProjection(changeSet)))),
    entry("payload/run.json", "application/json", "run", jsonBuffer(runProjection(repository, run))),
    entry("payload/worktree.json", "application/json", "worktree", jsonBuffer(safeUnknown(repository, { schemaVersion: 1, worktreeId: changeSet.worktreeId, branch: changeSet.branch, baseSha: changeSet.baseSha, headSha: changeSet.headSha, ownerId: changeSet.ownerId, parentRunId: changeSet.parentRunId, childRunId: changeSet.childRunId }))),
    entry("payload/completion-evidence.json", "application/json", "completion_evidence", jsonBuffer(safeUnknown(repository, run.completionEvidence || { schemaVersion: 1, outcome: "needs_attention", ledger: { changedFiles: [], verification: [], criteria: [], blockers: [] } }))),
    entry("payload/review.json", "application/json", "review", jsonBuffer(artifact)),
  ];
  if (artifact.scope.executionPlanId) entries.push(entry("payload/plan.json", "application/json", "plan", jsonBuffer(safeUnknown(repository, readExecutionPlan(repository, artifact.scope.executionPlanId)))));
  for (const id of [...run.contextManifestIds].sort()) entries.push(entry(`payload/context-manifests/${id}.json`, "application/json", "context_manifest", jsonBuffer(contextProjection(repository, id))));
  if (options.includeTrace !== false) {
    const trace = new TraceStore(repository).list({ runId: run.runId }).sort((left, right) => left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId)).map((event) => canonicalJson(safeUnknown(repository, event))).join("\n");
    entries.push(entry("payload/trace.ndjson", "application/x-ndjson", "trace", Buffer.from(trace ? `${trace}\n` : "", "utf8")));
  }
  if (options.includeTestOutput !== false) for (const verification of run.completionEvidence?.ledger.verification || []) if (verification.outputDigest) entries.push(entry(`payload/test-results/${verification.toolCallId || sha256(verification.command)}.json`, "application/json", "test_output", jsonBuffer(safeUnknown(repository, verification))));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const descriptors = entries.map(descriptor);
  const manifestBody = { bindings: artifact.scope, entries: descriptors };
  const manifest: EvidenceBundleManifestV1 = { schemaVersion: 1, kind: "crewforge.evidence-bundle-manifest", digestAlgorithm: "sha256", payloadDigest: `sha256:${sha256(canonicalJson(manifestBody))}`, bindings: artifact.scope, entries: descriptors, signature: { required: options.requireSignature === true, format: "dsse", payloadType: "application/vnd.crewforge.bundle-manifest.v1+json" } };
  const bundle: EvidenceBundleV1 = { schemaVersion: 1, kind: "crewforge.evidence-bundle", manifest, entries, signatures: [] };
  const bytes = jsonBuffer(bundle); if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("Evidence bundle exceeds the safe size limit"); return bytes;
}

function issue(result: EvidenceBundleVerification, code: string, message: string): void { result.issues.push({ code, message }); }
function safeEntryPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 1_000 || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  return path.posix.normalize(value) === value && value.split("/").every((part) => part && part !== "." && part !== "..");
}
function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_ENTRY_BYTES / 3) * 4 + 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64"); return decoded.toString("base64") === value ? decoded : null;
}
function parseJsonEntry(entries: Map<string, Buffer>, name: string): Record<string, unknown> | null { try { const parsed = JSON.parse(entries.get(name)?.toString("utf8") || "") as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
function changedFilesFromPatch(repository: string, patchFile: string): string[] {
  const output = execFileSync("git", ["-C", repository, "apply", "--numstat", "-z", patchFile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return [...new Set(output.split("\0").filter(Boolean).map((row) => row.slice(row.lastIndexOf("\t") + 1)))].sort();
}
function checkApplicability(repository: string, baseSha: string, patchFile: string): { baseAvailable: boolean; patchApplies: boolean } {
  try { execFileSync("git", ["-C", repository, "cat-file", "-e", `${baseSha}^{commit}`], { stdio: "ignore" }); } catch { return { baseAvailable: false, patchApplies: false }; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-bundle-verify-")); const index = path.join(temporary, "index");
  try {
    const env = { PATH: process.env.PATH || "/usr/bin:/bin", GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: temporary };
    execFileSync("git", ["-C", repository, "read-tree", baseSha], { env, stdio: "ignore" });
    execFileSync("git", ["-C", repository, "apply", "--check", "--cached", "--binary", patchFile], { env, stdio: "ignore" });
    return { baseAvailable: true, patchApplies: true };
  } catch { return { baseAvailable: true, patchApplies: false }; }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Fully validates an untrusted bundle without mutating the repository or workspace. */
export function verifyEvidenceBundle(workspaceDir: string, input: Buffer | string): EvidenceBundleVerification {
  const result: EvidenceBundleVerification = { integrity: "failed", authenticity: "invalid", bindings: "failed", applicability: { baseAvailable: false, patchApplies: false, changedFilesMatch: false }, issues: [] };
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (bytes.byteLength > MAX_BUNDLE_BYTES) { issue(result, "bundle_too_large", "Evidence bundle exceeds the safe size limit"); return result; }
  let bundle: EvidenceBundleV1;
  try { bundle = JSON.parse(bytes.toString("utf8")) as EvidenceBundleV1; } catch { issue(result, "invalid_json", "Evidence bundle is not valid JSON"); return result; }
  if (canonicalJson(bundle) !== bytes.toString("utf8")) { issue(result, "noncanonical_bundle", "Evidence bundle must use canonical JSON without duplicate or ambiguous fields"); return result; }
  if (bundle?.schemaVersion !== 1 || bundle.kind !== "crewforge.evidence-bundle" || bundle.manifest?.schemaVersion !== 1 || bundle.manifest.kind !== "crewforge.evidence-bundle-manifest" || !Array.isArray(bundle.entries) || !Array.isArray(bundle.signatures)) { issue(result, "invalid_schema", "Evidence bundle schema is invalid"); return result; }
  if (bundle.entries.length > MAX_ENTRIES || bundle.manifest.entries.length !== bundle.entries.length) { issue(result, "entry_limit", "Evidence bundle entry count is invalid"); return result; }
  const names = new Set<string>(); const folded = new Set<string>(); const contents = new Map<string, Buffer>(); let total = 0;
  for (const item of bundle.entries) {
    const keys = Object.keys(item).sort(); const expectedKeys = ["bytes", "content", "encoding", "kind", "mediaType", "path", "role", "sha256"].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || item.kind !== "file" || item.encoding !== "base64") { issue(result, "unsupported_entry", "Bundle entries must be regular inline files without links or compression"); continue; }
    if (!safeEntryPath(item.path)) { issue(result, "unsafe_path", "Bundle entry path is unsafe"); continue; }
    const lower = item.path.toLocaleLowerCase("en-US"); if (names.has(item.path) || folded.has(lower)) { issue(result, "duplicate_path", "Duplicate or case-colliding bundle entry path"); continue; } names.add(item.path); folded.add(lower);
    const content = decodeBase64(item.content); if (!content || content.byteLength !== item.bytes || content.byteLength > MAX_ENTRY_BYTES || sha256(content) !== item.sha256) { issue(result, "entry_integrity", `Bundle entry failed integrity validation: ${item.path}`); continue; }
    total += content.byteLength; if (total > MAX_TOTAL_PAYLOAD_BYTES) { issue(result, "payload_too_large", "Evidence bundle payload exceeds the safe limit"); break; }
    contents.set(item.path, content);
  }
  if (result.issues.length) return result;
  const descriptors = bundle.entries.map(descriptor).sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(descriptors) !== canonicalJson([...bundle.manifest.entries].sort((left, right) => left.path.localeCompare(right.path)))) { issue(result, "manifest_entries", "Manifest entries do not match payload entries"); return result; }
  const expectedPayload = `sha256:${sha256(canonicalJson({ bindings: bundle.manifest.bindings, entries: bundle.manifest.entries }))}`;
  if (bundle.manifest.payloadDigest !== expectedPayload) { issue(result, "manifest_digest", "Manifest payload digest is invalid"); return result; }
  result.bundleId = bundle.manifest.payloadDigest; result.integrity = "verified";
  result.authenticity = bundle.signatures.length === 0 ? "unsigned" : bundle.signatures.every((signature) => signature?.format === "dsse" && typeof signature.keyId === "string" && typeof signature.envelope === "string") ? "untrusted" : "invalid";
  if (bundle.manifest.signature.required) issue(result, "signature_required", "Bundle policy requires a trusted signature");
  const changeSet = parseJsonEntry(contents, "payload/change-set.json"); const review = parseJsonEntry(contents, "payload/review.json") as unknown as ReviewArtifactV1 | null; const run = parseJsonEntry(contents, "payload/run.json"); const patch = contents.get("payload/change.patch");
  if (!changeSet || !review || !run || !patch) { issue(result, "required_entry", "Bundle is missing a required bound artifact"); return result; }
  const binding = bundle.manifest.bindings;
  const exact = changeSet.id === binding.changeSetId && changeSet.worktreeId === binding.worktreeId && changeSet.captureIntegritySha256 === binding.revision && changeSet.patchSha256 === binding.patchContentSha256 && changeSet.baseSha === binding.baseSha && changeSet.headSha === binding.headSha && changeSet.childRunId === binding.childRunId && run.runId === binding.childRunId && run.conversationId === binding.conversationId && review.scope && canonicalJson(review.scope) === canonicalJson(binding) && review.artifactDigest === `sha256:${sha256(canonicalJson({ schemaVersion: review.schemaVersion, kind: review.kind, scope: review.scope, reviewRuns: review.reviewRuns, findings: review.findings, evidenceIndex: review.evidenceIndex, gate: review.gate }))}`;
  if (!exact || (binding.executionPlanId && !contents.has("payload/plan.json"))) issue(result, "binding_mismatch", "Bundle artifacts do not share the exact immutable bindings");
  if (sha256(patch) !== binding.patchContentSha256 || changeSet.patchSha256 !== sha256(patch)) issue(result, "patch_digest", "Patch does not match the bound immutable revision");
  result.bindings = result.issues.some((item) => item.code !== "signature_required") ? "failed" : "verified";
  const repository = repositoryRoot(workspaceDir); const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-bundle-patch-")); const patchFile = path.join(temporary, "change.patch");
  try {
    fs.writeFileSync(patchFile, patch, { flag: "wx" });
    try { const declared = Array.isArray(changeSet.changedFiles) ? [...new Set(changeSet.changedFiles.filter((item): item is string => typeof item === "string"))].sort() : []; result.applicability.changedFilesMatch = canonicalJson(changedFilesFromPatch(repository, patchFile)) === canonicalJson(declared); } catch { result.applicability.changedFilesMatch = false; }
    const applicable = checkApplicability(repository, binding.baseSha, patchFile); result.applicability.baseAvailable = applicable.baseAvailable; result.applicability.patchApplies = applicable.patchApplies;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  if (!result.applicability.changedFilesMatch) issue(result, "patch_scope", "Patch file scope does not match ChangeSet metadata");
  if (result.issues.some((item) => item.code !== "signature_required")) { result.integrity = "failed"; result.bindings = "failed"; }
  return result;
}
