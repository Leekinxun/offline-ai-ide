import crypto from "node:crypto";
import path from "node:path";
import { redactSecrets } from "../agent/secretRedaction.js";
import { changeSetReviewRevision, getChangeSet, preflightChangeSetDecision } from "../chat/changeSets.js";
import { listChangeSetReviewRuns } from "../chat/changeSetReviewRun.js";
import { ReviewFindingStore, type StoredReviewFinding } from "../chat/reviewFindingStore.js";
import { readRunRecord } from "../chat/runHistory.js";

export interface ReviewArtifactScopeV1 {
  conversationId: string;
  executionPlanId?: string;
  parentRunId?: string;
  childRunId: string;
  worktreeId: string;
  changeSetId: string;
  revision: string;
  patchContentSha256: string;
  baseSha: string;
  headSha: string;
}

export interface ReviewArtifactV1 {
  schemaVersion: 1;
  kind: "crewforge.review";
  artifactDigest: `sha256:${string}`;
  scope: ReviewArtifactScopeV1;
  reviewRuns: Array<{
    id: string;
    stage: "review" | "reverify";
    attempt: number;
    retryOf?: string;
    status: "queued" | "running" | "completed" | "failed" | "interrupted";
    requestedBy: string;
    reviewer: ExportReviewActor;
    verifier?: ExportReviewActor;
    checkoutDigest: string;
    findingIds: string[];
    verificationResults?: Array<{
      findingId: string;
      fingerprint: string;
      status: "verified" | "reproduced";
      revision: string;
      reviewRunId: string;
      evidence: string[];
      verifier: ExportReviewActor;
    }>;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
  }>;
  findings: ExportReviewFinding[];
  evidenceIndex: Array<{
    id: string;
    kind: "finding_evidence" | "completion_criterion" | "test_output";
    sha256: string;
    refs: string[];
  }>;
  gate: {
    decision: "ready" | "blocked";
    blockers: Array<{ code: string; findingId?: string; reason: string }>;
  };
}

export interface ExportReviewActor {
  id: string;
  modelName?: string;
  profile?: string;
  revision?: string;
  changeSetId?: string;
  reviewRunId?: string;
}

export interface ExportReviewFinding {
  id: string;
  fingerprint: string;
  severity: StoredReviewFinding["severity"];
  path: string;
  line: number;
  column?: number;
  message: string;
  evidence: string[];
  lifecycle: StoredReviewFinding["lifecycle"];
  version: number;
  reviewer?: ExportReviewActor;
  verifier?: ExportReviewActor;
  fixRef?: string;
  dismissalReason?: string;
  transitions: Array<{
    from: StoredReviewFinding["lifecycle"];
    to: StoredReviewFinding["lifecycle"];
    at: number;
    actor: ExportReviewActor;
    reason?: string;
    fixRef?: string;
    evidence?: string[];
    version: number;
  }>;
}

export interface ReviewFindingExportScopeV1 {
  runId?: string;
  conversationId?: string;
  changeSetId?: string;
  reviewRunId?: string;
  status?: StoredReviewFinding["lifecycle"];
  severity?: StoredReviewFinding["severity"];
}

export interface SarifReviewArtifactV1 {
  version: "2.1.0";
  $schema: "https://json.schemastore.org/sarif-2.1.0.json";
  runs: Array<Record<string, unknown>>;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeText(workspaceDir: string, value: unknown, max = 4_000): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const workspace = path.resolve(workspaceDir);
  const escaped = workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return redactSecrets(value)
    .replace(new RegExp(escaped, "g"), "[WORKSPACE]")
    .replace(/(^|[\s"'=])\/(?!\/)[^\s"']+/g, "$1[ABS_PATH]")
    .replace(/(^|[\s"'=])[A-Za-z]:\\[^\s"']+/g, "$1[ABS_PATH]")
    .trim()
    .slice(0, max);
}

function safeActor(workspaceDir: string, actor: ExportReviewActor | undefined): ExportReviewActor | undefined {
  const id = safeText(workspaceDir, actor?.id, 160);
  if (!actor || !id) return undefined;
  return {
    id,
    ...(safeText(workspaceDir, actor.modelName, 200) ? { modelName: safeText(workspaceDir, actor.modelName, 200) } : {}),
    ...(safeText(workspaceDir, actor.profile, 160) ? { profile: safeText(workspaceDir, actor.profile, 160) } : {}),
    ...(safeText(workspaceDir, actor.revision, 160) ? { revision: safeText(workspaceDir, actor.revision, 160) } : {}),
    ...(safeText(workspaceDir, actor.changeSetId, 160) ? { changeSetId: safeText(workspaceDir, actor.changeSetId, 160) } : {}),
    ...(safeText(workspaceDir, actor.reviewRunId, 160) ? { reviewRunId: safeText(workspaceDir, actor.reviewRunId, 160) } : {}),
  };
}

function exportFinding(workspaceDir: string, finding: StoredReviewFinding): ExportReviewFinding {
  const clean = (values: string[] | undefined) => (values || []).flatMap((value) => {
    const text = safeText(workspaceDir, value, 2_000); return text ? [text] : [];
  });
  return {
    id: finding.id,
    fingerprint: finding.fingerprint,
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    ...(finding.column ? { column: finding.column } : {}),
    message: safeText(workspaceDir, finding.message) || "Redacted review finding",
    evidence: clean(finding.evidence),
    lifecycle: finding.lifecycle,
    version: finding.version,
    ...(safeActor(workspaceDir, finding.reviewer) ? { reviewer: safeActor(workspaceDir, finding.reviewer) } : {}),
    ...(safeActor(workspaceDir, finding.verifier) ? { verifier: safeActor(workspaceDir, finding.verifier) } : {}),
    ...(safeText(workspaceDir, finding.fixRef, 300) ? { fixRef: safeText(workspaceDir, finding.fixRef, 300) } : {}),
    ...(safeText(workspaceDir, finding.dismissalReason, 2_000) ? { dismissalReason: safeText(workspaceDir, finding.dismissalReason, 2_000) } : {}),
    transitions: finding.transitions.map((transition) => ({
      from: transition.from,
      to: transition.to,
      at: transition.at,
      actor: safeActor(workspaceDir, transition.actor) || { id: "redacted" },
      ...(safeText(workspaceDir, transition.reason, 2_000) ? { reason: safeText(workspaceDir, transition.reason, 2_000) } : {}),
      ...(safeText(workspaceDir, transition.fixRef, 300) ? { fixRef: safeText(workspaceDir, transition.fixRef, 300) } : {}),
      ...(clean(transition.evidence).length ? { evidence: clean(transition.evidence) } : {}),
      version: transition.version,
    })),
  };
}

function evidenceIndex(findings: ExportReviewFinding[], completionEvidence: ReturnType<typeof readRunRecord>["completionEvidence"]): ReviewArtifactV1["evidenceIndex"] {
  const entries = new Map<string, ReviewArtifactV1["evidenceIndex"][number]>();
  const add = (kind: ReviewArtifactV1["evidenceIndex"][number]["kind"], content: string, ref: string) => {
    const digest = sha256(content); const id = `evidence-${digest}`;
    const existing = entries.get(id);
    if (existing) existing.refs = [...new Set([...existing.refs, ref])].sort();
    else entries.set(id, { id, kind, sha256: digest, refs: [ref] });
  };
  for (const finding of findings) for (const item of finding.evidence) add("finding_evidence", item, finding.id);
  for (const finding of findings) for (const transition of finding.transitions) for (const item of transition.evidence || []) add("finding_evidence", item, `${finding.id}:v${transition.version}`);
  for (const verification of completionEvidence?.ledger.verification || []) if (verification.outputDigest) add("test_output", verification.outputDigest, verification.toolCallId || verification.command);
  for (const criterion of completionEvidence?.ledger.criteria || []) for (const ref of criterion.evidenceRefs) add("completion_criterion", criterion.criterion, ref);
  return [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function buildReviewArtifact(workspaceDir: string, changeSetId: string, expectedRevision?: string): ReviewArtifactV1 {
  const changeSet = getChangeSet(workspaceDir, changeSetId);
  const reviewRevision = changeSetReviewRevision(changeSet);
  if (expectedRevision && reviewRevision !== expectedRevision) throw new Error("Change set revision is stale");
  if (!changeSet.childRunId) throw new Error("Change set is missing child run binding");
  const run = readRunRecord(workspaceDir, changeSet.childRunId);
  const scope: ReviewArtifactScopeV1 = {
    conversationId: run.conversationId,
    ...(run.executionPlanId ? { executionPlanId: run.executionPlanId } : {}),
    ...(changeSet.parentRunId || run.parentRunId ? { parentRunId: changeSet.parentRunId || run.parentRunId } : {}),
    childRunId: changeSet.childRunId,
    worktreeId: changeSet.worktreeId,
    changeSetId: changeSet.id,
    revision: reviewRevision,
    patchContentSha256: changeSet.patchSha256,
    baseSha: changeSet.baseSha,
    headSha: changeSet.headSha,
  };
  const reviewRuns = listChangeSetReviewRuns(workspaceDir, changeSet.id)
    .filter((item) => item.revision === reviewRevision)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      stage: item.stage,
      attempt: item.attempt,
      ...(item.retryOf ? { retryOf: item.retryOf } : {}),
      status: item.status,
      requestedBy: safeText(workspaceDir, item.requestedBy, 160) || "redacted",
      reviewer: safeActor(workspaceDir, item.reviewer)!,
      ...(item.verifier ? { verifier: safeActor(workspaceDir, item.verifier) } : {}),
      checkoutDigest: item.checkoutDigest,
      findingIds: [...new Set(item.findingIds)].sort(),
      ...(item.verificationResults ? { verificationResults: item.verificationResults.map((result) => ({ ...result, evidence: result.evidence.flatMap((value) => safeText(workspaceDir, value, 2_000) ? [safeText(workspaceDir, value, 2_000)!] : []), verifier: safeActor(workspaceDir, result.verifier)! })) } : {}),
      createdAt: item.createdAt,
      ...(item.startedAt ? { startedAt: item.startedAt } : {}),
      ...(item.completedAt ? { completedAt: item.completedAt } : {}),
      ...(safeText(workspaceDir, item.error, 1_000) ? { error: safeText(workspaceDir, item.error, 1_000) } : {}),
    }));
  const findings = new ReviewFindingStore(workspaceDir).list()
    .filter((item) => (item.changeSetId === changeSet.id && item.reviewer?.revision === reviewRevision) || (item.verifier?.changeSetId === changeSet.id && item.verifier.revision === reviewRevision))
    .map((item) => exportFinding(workspaceDir, item))
    .sort((left, right) => left.id.localeCompare(right.id));
  const preflight = preflightChangeSetDecision(workspaceDir, changeSet, "apply", { id: "review-artifact", isAdmin: true });
  // The artifact gate is immutable-revision evidence only. Parent cleanliness,
  // overlapping live worktrees, and current merge conflicts belong to the
  // integration preflight and must not make repeated exports nondeterministic.
  const blockers: ReviewArtifactV1["gate"]["blockers"] = (preflight.blockingFindings || []).map((item) => ({ code: "review_finding", findingId: item.id, reason: safeText(workspaceDir, item.reason, 1_000) || "Review finding blocks integration" }));
  const body = {
    schemaVersion: 1 as const,
    kind: "crewforge.review" as const,
    scope,
    reviewRuns,
    findings,
    evidenceIndex: evidenceIndex(findings, run.completionEvidence),
    gate: { decision: blockers.length ? "blocked" as const : "ready" as const, blockers },
  };
  return { ...body, artifactDigest: `sha256:${sha256(canonicalJson(body))}` };
}

export function toSarifReviewArtifact(artifact: ReviewArtifactV1): SarifReviewArtifactV1 {
  const sarif = toSarifFindings(artifact.findings, artifact.scope);
  const run = sarif.runs[0] as Record<string, any>;
  run.properties = { crewforge: { artifactDigest: artifact.artifactDigest, scope: artifact.scope, reviewRuns: artifact.reviewRuns, gate: artifact.gate, evidenceIndex: artifact.evidenceIndex } };
  return sarif;
}

function sarifLevel(severity: ExportReviewFinding["severity"]): "error" | "warning" | "note" {
  return severity === "critical" || severity === "error" ? "error" : severity === "warning" ? "warning" : "note";
}

function toSarifFindings(findings: ExportReviewFinding[], scope: object): SarifReviewArtifactV1 {
  const fingerprints = [...new Set(findings.map((finding) => finding.fingerprint))].sort();
  const ruleIndex = new Map(fingerprints.map((fingerprint, index) => [fingerprint, index]));
  const firstByFingerprint = new Map<string, ExportReviewFinding>();
  for (const finding of findings) if (!firstByFingerprint.has(finding.fingerprint)) firstByFingerprint.set(finding.fingerprint, finding);
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "CrewForge Independent Review", rules: fingerprints.map((fingerprint) => {
        const finding = firstByFingerprint.get(fingerprint)!;
        return { id: fingerprint, name: `CrewForge-${fingerprint.slice(0, 12)}`, shortDescription: { text: finding.message }, defaultConfiguration: { level: sarifLevel(finding.severity) }, properties: { crewforgeSeverity: finding.severity } };
      }) } },
      results: findings.map((finding) => ({
        ruleId: finding.fingerprint,
        ruleIndex: ruleIndex.get(finding.fingerprint),
        level: sarifLevel(finding.severity),
        message: { text: finding.message },
        locations: [{ physicalLocation: { artifactLocation: { uri: finding.path }, region: { startLine: finding.line, ...(finding.column ? { startColumn: finding.column } : {}) } } }],
        fingerprints: { crewforgeReviewFingerprint: finding.fingerprint },
        properties: { crewforge: { id: finding.id, lifecycle: finding.lifecycle, version: finding.version, evidence: finding.evidence, reviewer: finding.reviewer, verifier: finding.verifier } },
      })),
      properties: { crewforge: { scope } },
    }],
  };
}

export function toSarifReviewFindings(workspaceDir: string, findings: StoredReviewFinding[], scope: ReviewFindingExportScopeV1): SarifReviewArtifactV1 {
  return toSarifFindings(findings.map((finding) => exportFinding(workspaceDir, finding)), scope);
}
