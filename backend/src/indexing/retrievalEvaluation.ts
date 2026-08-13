import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRetrievalReferenceFixture,
  type RetrievalCategory,
  type RetrievalReferenceCase,
  type RetrievalReferenceFixture,
} from "./fixtures/referenceFixture.js";
import {
  rebuildRepositoryIndex,
  retrieveRepositoryContext,
  type RepositoryContextCandidate,
  type RepositoryDiagnosticSignal,
} from "./repositoryIndex.js";

export const RETRIEVAL_RECALL_THRESHOLD = 0.9;
export const RETRIEVAL_SYMBOL_THRESHOLD = 0.9;
export const RETRIEVAL_MRR_THRESHOLD = 0.75;

export interface RetrievalCaseResult {
  id: string;
  category: RetrievalCategory;
  k: number;
  expectedPaths: string[];
  retrievedPaths: string[];
  recall: number;
  reciprocalRank: number;
  symbolHits: number;
  symbolTotal: number;
  forbiddenHits: string[];
  sourceKeys: string[];
}

export interface RetrievalEvaluationReport {
  schemaVersion: 1;
  engineSchemaDigest: string;
  datasetDigest: string;
  treeDigest: string;
  caseCount: number;
  repeats: number;
  overallRecall: number;
  categoryRecall: Record<RetrievalCategory, number>;
  meanReciprocalRank: number;
  symbolAccuracy: number;
  deterministic: boolean;
  forbiddenLeakCount: number;
  thresholds: {
    categoryRecall: number;
    overallRecall: number;
    symbolAccuracy: number;
    meanReciprocalRank: number;
    forbiddenLeakCount: number;
  };
  passed: boolean;
  failures: string[];
  cases: RetrievalCaseResult[];
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function workspaceForCase(fixture: RetrievalReferenceFixture, entry: RetrievalReferenceCase): string {
  if (entry.workspaceVariant === "worktree-a") return fixture.worktreeA;
  if (entry.workspaceVariant === "worktree-b") return fixture.worktreeB;
  return fixture.main;
}

function distinctPaths(candidates: RepositoryContextCandidate[], limit: number): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.path || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    paths.push(candidate.path);
    if (paths.length >= limit) break;
  }
  return paths;
}

async function runCase(
  fixture: RetrievalReferenceFixture,
  entry: RetrievalReferenceCase
): Promise<RetrievalCaseResult> {
  const diagnostics: RepositoryDiagnosticSignal[] | undefined = entry.diagnostics?.map((diagnostic) => ({
    ...diagnostic,
    column: 1,
    severity: "error",
  }));
  const candidates = await retrieveRepositoryContext({
    workspaceDir: workspaceForCase(fixture, entry),
    query: entry.query,
    currentPath: entry.currentPath || entry.changedPaths?.[0],
    diagnostics,
    maxResults: 100,
    maxTokens: 200_000,
    semantic: { mode: "off" },
  });
  const retrievedPaths = distinctPaths(candidates, entry.k);
  const expected = new Set(entry.expectedPaths);
  const hits = retrievedPaths.filter((candidatePath) => expected.has(candidatePath)).length;
  const firstRelevant = retrievedPaths.findIndex((candidatePath) => expected.has(candidatePath));
  const symbolHits = (entry.expectedSymbols || []).filter((symbol) =>
    candidates.some((candidate) =>
      candidate.path === symbol.path &&
      candidate.symbol === symbol.symbol &&
      candidate.range &&
      Math.abs(candidate.range.startLine - symbol.line) <= 1
    )
  ).length;
  const forbidden = new Set(entry.forbiddenPaths || []);
  const forbiddenHits = [...new Set(candidates.flatMap((candidate) =>
    candidate.path && forbidden.has(candidate.path) ? [candidate.path] : []
  ))].sort();
  return {
    id: entry.id,
    category: entry.category,
    k: entry.k,
    expectedPaths: [...entry.expectedPaths],
    retrievedPaths,
    recall: round(hits / entry.expectedPaths.length),
    reciprocalRank: firstRelevant >= 0 ? round(1 / (firstRelevant + 1)) : 0,
    symbolHits,
    symbolTotal: entry.expectedSymbols?.length || 0,
    forbiddenHits,
    sourceKeys: candidates.map((candidate) => candidate.sourceKey),
  };
}

export async function evaluateRetrievalFixture(options: {
  fixture: RetrievalReferenceFixture;
  repeats?: number;
}): Promise<RetrievalEvaluationReport> {
  const repeats = Math.max(3, Math.min(10, Math.floor(options.repeats || 3)));
  await Promise.all([
    rebuildRepositoryIndex(options.fixture.main),
    rebuildRepositoryIndex(options.fixture.worktreeA),
    rebuildRepositoryIndex(options.fixture.worktreeB),
  ]);

  const runs: RetrievalCaseResult[][] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const results: RetrievalCaseResult[] = [];
    for (const entry of options.fixture.cases) results.push(await runCase(options.fixture, entry));
    runs.push(results);
  }
  const cases = runs[0];
  const deterministic = runs.slice(1).every((run) =>
    run.every((entry, index) =>
      entry.id === cases[index]?.id &&
      JSON.stringify(entry.sourceKeys) === JSON.stringify(cases[index]?.sourceKeys)
    )
  );
  const categories: RetrievalCategory[] = [
    "navigation",
    "bug_localization",
    "cross_file_change",
    "test_selection",
  ];
  const categoryRecall = Object.fromEntries(categories.map((category) => [
    category,
    round(mean(cases.filter((entry) => entry.category === category).map((entry) => entry.recall))),
  ])) as Record<RetrievalCategory, number>;
  const symbolHits = cases.reduce((sum, entry) => sum + entry.symbolHits, 0);
  const symbolTotal = cases.reduce((sum, entry) => sum + entry.symbolTotal, 0);
  const overallRecall = round(mean(cases.map((entry) => entry.recall)));
  const meanReciprocalRank = round(mean(cases.map((entry) => entry.reciprocalRank)));
  const symbolAccuracy = symbolTotal ? round(symbolHits / symbolTotal) : 0;
  const forbiddenLeakCount = cases.reduce((sum, entry) => sum + entry.forbiddenHits.length, 0);
  const failures = [
    ...categories.flatMap((category) => categoryRecall[category] >= RETRIEVAL_RECALL_THRESHOLD
      ? []
      : [`${category} Recall@K ${categoryRecall[category]} < ${RETRIEVAL_RECALL_THRESHOLD}`]),
    ...(overallRecall >= RETRIEVAL_RECALL_THRESHOLD ? [] : [`overall Recall@K ${overallRecall} < ${RETRIEVAL_RECALL_THRESHOLD}`]),
    ...(symbolAccuracy >= RETRIEVAL_SYMBOL_THRESHOLD ? [] : [`symbol line accuracy ${symbolAccuracy} < ${RETRIEVAL_SYMBOL_THRESHOLD}`]),
    ...(meanReciprocalRank >= RETRIEVAL_MRR_THRESHOLD ? [] : [`MRR ${meanReciprocalRank} < ${RETRIEVAL_MRR_THRESHOLD}`]),
    ...(deterministic ? [] : ["retrieval ranking changed across repeated runs"]),
    ...(forbiddenLeakCount === 0 ? [] : [`forbidden retrieval leak count ${forbiddenLeakCount} != 0`]),
  ];

  return {
    schemaVersion: 1,
    engineSchemaDigest: digest("crewforge-repository-index-schema-v1"),
    datasetDigest: options.fixture.datasetDigest,
    treeDigest: options.fixture.treeDigest,
    caseCount: cases.length,
    repeats,
    overallRecall,
    categoryRecall,
    meanReciprocalRank,
    symbolAccuracy,
    deterministic,
    forbiddenLeakCount,
    thresholds: {
      categoryRecall: RETRIEVAL_RECALL_THRESHOLD,
      overallRecall: RETRIEVAL_RECALL_THRESHOLD,
      symbolAccuracy: RETRIEVAL_SYMBOL_THRESHOLD,
      meanReciprocalRank: RETRIEVAL_MRR_THRESHOLD,
      forbiddenLeakCount: 0,
    },
    passed: failures.length === 0,
    failures,
    cases,
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewforge-retrieval-eval-"));
  try {
    const report = await evaluateRetrievalFixture({
      fixture: createRetrievalReferenceFixture(root),
      repeats: Number(argument("--repeat") || 3),
    });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    const outputPath = argument("--json");
    if (outputPath) {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), output, "utf8");
    }
    process.stdout.write(output);
    if (!report.passed && !process.argv.includes("--no-assert")) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
