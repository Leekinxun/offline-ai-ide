import crypto from "node:crypto";
import type { PersistedChatMessage, PersistedToolCallStep } from "./history.js";
import { redactSecrets } from "../agent/secretRedaction.js";
import {
  listFileMutations,
  listMutationEvidenceGaps,
  type MutationEvidenceGap,
} from "../files/mutationRegistry.js";
import { listChangeSets, type ChangeSet } from "./changeSets.js";
import { collectChangeEvidenceGaps } from "./changeEvidence.js";

export const COMPLETION_EVIDENCE_SCHEMA_VERSION = 1;

export interface CompletionEvidencePlan {
  verificationCommands?: readonly string[];
  acceptanceCriteria?: readonly string[];
}

export interface CompletionEvidenceBlockers {
  childRun?: boolean;
  approval?: boolean;
  amendment?: boolean;
  conflict?: boolean;
  check?: boolean;
  changeEvidence?: boolean;
  quality?: boolean;
}

export interface CompletionEvidenceInput {
  plan?: CompletionEvidencePlan | null;
  messages: readonly PersistedChatMessage[];
  stopped?: boolean;
  baseError?: boolean;
  blockers?: CompletionEvidenceBlockers;
  /** Criterion index (as a string) or exact criterion text to successful bash tool-call ids. */
  criterionEvidence?: Readonly<Record<string, readonly string[]>>;
  /** Durable mutation/ChangeSet paths supplied by the runtime evidence collector. */
  changedFiles?: readonly string[];
}

export type VerificationStatus = "pending" | "passed" | "failed" | "timed_out" | "cancelled";
export type CriterionState = "pending" | "passed" | "failed";
export type CompletionOutcome = "completed" | "validation_failed" | "needs_attention" | "failed" | "stopped";

export interface CompletionEvidenceLedger {
  changedFiles: string[];
  verification: Array<{
    command: string;
    status: VerificationStatus;
    toolCallId?: string;
    exitCode?: number;
    outputDigest?: string;
  }>;
  criteria: Array<{ criterion: string; state: CriterionState; evidenceRefs: string[] }>;
  blockers: Array<keyof CompletionEvidenceBlockers>;
}

export interface CompletionEvidence {
  schemaVersion: typeof COMPLETION_EVIDENCE_SCHEMA_VERSION;
  ledger: CompletionEvidenceLedger;
  outcome: CompletionOutcome;
}

export interface AuthoritativeChangeEvidence {
  changedFiles: string[];
  mutationEvidenceGaps: MutationEvidenceGap[];
}

export function changeSetsContainEvidenceGaps(
  changeSets: readonly Pick<ChangeSet, "checks" | "verificationEvidence">[]
): boolean {
  return changeSets.some((changeSet) => collectChangeEvidenceGaps(changeSet.checks, changeSet.verificationEvidence).length > 0);
}

/**
 * Builds the authoritative changed-file ledger for a run. Direct tool paths are
 * joined by deriveCompletionEvidence; this collector adds checkpoint-captured
 * shell mutations and isolated child ChangeSets. Paths are de-duplicated so a
 * write observed by more than one source is still represented exactly once.
 */
export function collectAuthoritativeChangeEvidence(
  workspaceDir: string,
  runId: string,
  descendantRunIds: readonly string[] = []
): AuthoritativeChangeEvidence {
  const runIds = new Set([runId, ...descendantRunIds]);
  const mutationPaths = listFileMutations(workspaceDir)
    .filter((record) => Boolean(record.runId && runIds.has(record.runId)))
    .map((record) => record.path);
  const mutationEvidenceGaps = listMutationEvidenceGaps(workspaceDir)
    .filter((gap) => runIds.has(gap.runId));
  let changeSets: ReturnType<typeof listChangeSets> = [];
  try { changeSets = listChangeSets(workspaceDir); }
  catch (error) {
    if (!/not a git repository/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  const changeSetPaths = changeSets.flatMap((changeSet) =>
    changeSet.parentRunId === runId || Boolean(changeSet.childRunId && runIds.has(changeSet.childRunId))
      ? changeSet.changedFiles
      : []
  );
  return {
    changedFiles: Array.from(new Set([...mutationPaths, ...changeSetPaths].map((value) => redactSecrets(value)))).sort(),
    mutationEvidenceGaps,
  };
}

export function collectAuthoritativeChangedFiles(
  workspaceDir: string,
  runId: string,
  descendantRunIds: readonly string[] = []
): string[] {
  return collectAuthoritativeChangeEvidence(workspaceDir, runId, descendantRunIds).changedFiles;
}

interface BashEvidence {
  toolCallId: string;
  command: string;
  status: Exclude<VerificationStatus, "pending">;
  exitCode?: number;
  outputDigest: string;
}

function cleanList(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean)));
}

function digest(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function bashEvidence(tool: PersistedToolCallStep): BashEvidence | null {
  if (tool.name !== "bash" || typeof tool.input.command !== "string" || !tool.input.command.trim()) return null;
  const output = tool.result || "";
  const exitCode = output.match(/exited with code\s+(\d+)/i)?.[1];
  const status: BashEvidence["status"] = tool.isError
    ? (/timeout/i.test(output) ? "timed_out" : /stopp?ed|cancelled/i.test(output) ? "cancelled" : "failed")
    : "passed";
  return {
    toolCallId: tool.toolCallId,
    command: tool.input.command.trim(),
    status,
    ...(exitCode ? { exitCode: Number(exitCode) } : status === "passed" ? { exitCode: 0 } : {}),
    // Digest only display-safe output so it cannot serve as an oracle for known secrets.
    outputDigest: digest(redactSecrets(output)),
  };
}

function allTools(messages: readonly PersistedChatMessage[]): PersistedToolCallStep[] {
  return messages.flatMap((message) => message.toolCalls || []);
}

function submittedCriterionEvidence(tools: readonly PersistedToolCallStep[]): Readonly<Record<string, readonly string[]>> | undefined {
  for (const tool of [...tools].reverse()) {
    if (tool.name !== "submit_completion_evidence" || tool.isError) continue;
    const candidate = tool.input.criterionEvidence || tool.input.criteria;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).flatMap(([key, value]) =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [[key, value]] : []
    ));
  }
  return undefined;
}

/** Derives deterministic, display-safe completion evidence without reading state or executing commands. */
export function deriveCompletionEvidence(input: CompletionEvidenceInput): CompletionEvidence {
  const tools = allTools(input.messages);
  const bash = tools.flatMap((tool) => {
    const evidence = bashEvidence(tool);
    return evidence ? [evidence] : [];
  });
  const changedFiles = Array.from(new Set([
    ...(input.changedFiles || []).map((value) => redactSecrets(value)),
    ...tools.flatMap((tool) => tool.fileUpdate?.path ? [redactSecrets(tool.fileUpdate.path)] : []),
  ])).sort();
  const commands = cleanList(input.plan?.verificationCommands);
  const criteria = cleanList(input.plan?.acceptanceCriteria);
  const verification = commands.map((command) => {
    const evidence = bash.filter((entry) => entry.command === command).at(-1);
    return evidence
      ? { command: redactSecrets(command), status: evidence.status, toolCallId: evidence.toolCallId, ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}), outputDigest: evidence.outputDigest }
      : { command: redactSecrets(command), status: "pending" as const };
  });
  const requiredCommands = new Set(commands);
  const successfulEvidence = new Set(bash
    .filter((entry) => entry.status === "passed" && requiredCommands.has(entry.command))
    .map((entry) => entry.toolCallId));
  const criterionEvidence = input.criterionEvidence || submittedCriterionEvidence(tools);
  const criterionLedger = criteria.map((criterion, index) => {
    const requested = criterionEvidence?.[String(index)] || criterionEvidence?.[criterion] || [];
    const evidenceRefs = Array.from(new Set(requested.filter((id) => successfulEvidence.has(id)))).sort();
    const requestedFailed = requested.some((id) => bash.some((entry) =>
      entry.toolCallId === id && requiredCommands.has(entry.command) && entry.status !== "passed"
    ));
    return { criterion: redactSecrets(criterion), state: evidenceRefs.length ? "passed" as const : requestedFailed ? "failed" as const : "pending" as const, evidenceRefs };
  });
  const blockers = (["childRun", "approval", "amendment", "conflict", "check", "changeEvidence", "quality"] as const).filter((name) => input.blockers?.[name]);
  if ((verification.some((entry) => entry.status === "pending" || entry.status === "cancelled") || criterionLedger.some((entry) => entry.state === "pending")) && !blockers.includes("check")) blockers.push("check");
  const requiredFailed = verification.some((entry) => entry.status === "failed" || entry.status === "timed_out");
  const incomplete = verification.some((entry) => entry.status !== "passed") || criterionLedger.some((entry) => entry.state !== "passed");
  const outcome: CompletionOutcome = input.stopped ? "stopped"
    : blockers.length ? "needs_attention"
    : input.baseError ? "failed"
    : requiredFailed ? "validation_failed"
    : incomplete ? "needs_attention"
    : "completed";
  return { schemaVersion: COMPLETION_EVIDENCE_SCHEMA_VERSION, ledger: { changedFiles, verification, criteria: criterionLedger, blockers }, outcome };
}
