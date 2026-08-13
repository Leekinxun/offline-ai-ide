import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { digestFixtureTree, RETRIEVAL_REFERENCE_CASES } from "./fixtures/referenceFixture.js";
import { RepositoryIndexStore } from "./indexStore.js";
import {
  invalidateRepositoryIndex,
  rebuildRepositoryIndex,
  retrieveRepositoryContext,
} from "./repositoryIndex.js";

export type RetrievalBenchmarkProfile = "smoke" | "reference" | "large";

interface ProfileSettings {
  files: number;
  linesPerFile: number;
  incrementalSamples: number;
  querySamples: number;
  budgets: {
    coldMs: number;
    incrementalP95Ms: number;
    batch100Ms: number;
    queryP95Ms: number;
    queryP99Ms: number;
    rssBytes: number;
  };
}

const PROFILES: Record<RetrievalBenchmarkProfile, ProfileSettings> = {
  smoke: {
    files: 2_000,
    linesPerFile: 100,
    incrementalSamples: 20,
    querySamples: 50,
    budgets: {
      coldMs: 8_000,
      incrementalP95Ms: 200,
      batch100Ms: 2_000,
      queryP95Ms: 100,
      queryP99Ms: 250,
      rssBytes: 512 * 1024 * 1024,
    },
  },
  reference: {
    files: 20_000,
    linesPerFile: 100,
    incrementalSamples: 50,
    querySamples: 100,
    budgets: {
      coldMs: 60_000,
      incrementalP95Ms: 500,
      batch100Ms: 5_000,
      queryP95Ms: 150,
      queryP99Ms: 400,
      rssBytes: 1024 * 1024 * 1024,
    },
  },
  large: {
    files: 100_000,
    linesPerFile: 100,
    incrementalSamples: 50,
    querySamples: 100,
    budgets: {
      coldMs: 300_000,
      incrementalP95Ms: 1_000,
      batch100Ms: 15_000,
      queryP95Ms: 500,
      queryP99Ms: 1_200,
      rssBytes: 2.5 * 1024 * 1024 * 1024,
    },
  },
};

const OWNED_ROOT_PREFIX = "crewforge-retrieval-benchmark-";
const CLEANUP_RETRIES = 8;
const CLEANUP_RETRY_DELAY_MS = 75;

export interface RetrievalBenchmarkReport {
  schemaVersion: 1;
  profile: RetrievalBenchmarkProfile;
  environment: {
    platform: string;
    arch: string;
    node: string;
    cpuCount: number;
    totalMemoryBytes: number;
  };
  datasetDigest: string;
  treeDigest: string;
  engineSchemaDigest: string;
  scale: { files: number; lines: number; sourceBytes: number };
  cold: { elapsedMs: number; indexedFiles: number };
  incremental: {
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    filesScannedMax: number;
    unrelatedPartitionChanges: number;
  };
  batch100: { elapsedMs: number; filesScanned: number };
  query: { samples: number; p50Ms: number; p95Ms: number; p99Ms: number };
  rssBytes: number;
  indexBytes: number;
  budgets: ProfileSettings["budgets"];
  passed: boolean;
  failures: string[];
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(percentileValue * ordered.length) - 1));
  return Number(ordered[index].toFixed(3));
}

function directoryBytes(directory: string): number {
  let total = 0;
  const visit = (current: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  };
  visit(directory);
  return total;
}

function writeBenchmarkRepository(repository: string, settings: ProfileSettings): number {
  fs.mkdirSync(repository, { recursive: true });
  let sourceBytes = 0;
  for (let index = 0; index < settings.files; index += 1) {
    const filePath = path.join(repository, "src", `package-${String(index % 100).padStart(3, "0")}`, `file-${String(index).padStart(6, "0")}.ts`);
    const lines = [
      `export function benchmarkSymbol${index}(value: number): number { return value + ${index}; }`,
      `export const benchmarkValue${index} = benchmarkSymbol${index}(${index});`,
      ...Array.from({ length: settings.linesPerFile - 2 }, (_, line) => `// deterministic benchmark filler ${index} ${line}`),
    ];
    const content = `${lines.join("\n")}\n`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    sourceBytes += Buffer.byteLength(content);
  }
  fs.writeFileSync(path.join(repository, ".gitignore"), ".history/\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "seed retrieval benchmark"], {
    cwd: repository,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CrewForge Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
      GIT_COMMITTER_NAME: "CrewForge Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
      GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
    },
  });
  return sourceBytes;
}

function changedFileCount(
  before: Map<string, { contentHash: string; indexedAt: number }>,
  after: Map<string, { contentHash: string; indexedAt: number }>
): { changed: number; unrelated: number } {
  let changed = 0;
  let unrelated = 0;
  for (const [filePath, file] of after) {
    const previous = before.get(filePath);
    if (!previous || previous.contentHash !== file.contentHash || previous.indexedAt !== file.indexedAt) changed += 1;
  }
  for (const filePath of before.keys()) if (!after.has(filePath)) unrelated += 1;
  return { changed, unrelated };
}

function readAffectedFiles(store: RepositoryIndexStore, filePaths: string[]): Map<string, { contentHash: string; indexedAt: number }> {
  const result = new Map<string, { contentHash: string; indexedAt: number }>();
  const shards = new Set(filePaths.map((filePath) => store.shardId(filePath)));
  for (const shard of shards) for (const [filePath, file] of Object.entries(store.readShard(shard))) {
    result.set(filePath, { contentHash: file.contentHash, indexedAt: file.indexedAt });
  }
  return result;
}

async function removeOwnedBenchmarkRoot(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const temporaryDirectory = path.resolve(os.tmpdir());
  const basename = path.basename(resolvedRoot);
  if (
    path.dirname(resolvedRoot) !== temporaryDirectory ||
    !basename.startsWith(OWNED_ROOT_PREFIX) ||
    basename.length === OWNED_ROOT_PREFIX.length
  ) {
    throw new Error(`Refusing to remove non-benchmark temporary root: ${resolvedRoot}`);
  }
  try {
    const stat = await fs.promises.lstat(resolvedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove invalid benchmark temporary root: ${resolvedRoot}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(resolvedRoot, {
    recursive: true,
    force: true,
    maxRetries: CLEANUP_RETRIES,
    retryDelay: CLEANUP_RETRY_DELAY_MS,
  });
  if (fs.existsSync(resolvedRoot)) throw new Error(`Benchmark temporary root still exists after cleanup: ${resolvedRoot}`);
}

export async function runRetrievalBenchmark(options: {
  profile?: RetrievalBenchmarkProfile;
  root?: string;
} = {}): Promise<RetrievalBenchmarkReport> {
  const profile = options.profile || "smoke";
  const settings = PROFILES[profile];
  const root = options.root || await mkdtemp(path.join(os.tmpdir(), OWNED_ROOT_PREFIX));
  const ownsRoot = !options.root;
  let benchmarkFailure: unknown;
  try {
    const repository = path.join(root, `benchmark-${profile}`);
    const sourceBytes = writeBenchmarkRepository(repository, settings);
    const treeDigest = digestFixtureTree(repository);
    const coldStarted = performance.now();
    const coldStatus = await rebuildRepositoryIndex(repository);
    const coldMs = performance.now() - coldStarted;
    if (coldStatus.status !== "ready") throw new Error(`Cold index failed: ${coldStatus.lastError || coldStatus.status}`);
    const store = new RepositoryIndexStore(repository);
    const incrementalTimes: number[] = [];
    let filesScannedMax = 0;
    let unrelatedPartitionChanges = 0;

    for (let sample = 0; sample < settings.incrementalSamples; sample += 1) {
      const fileIndex = sample % settings.files;
      const relativePath = `src/package-${String(fileIndex % 100).padStart(3, "0")}/file-${String(fileIndex).padStart(6, "0")}.ts`;
      const before = readAffectedFiles(store, [relativePath]);
      fs.appendFileSync(path.join(repository, relativePath), `export const incrementalRevision${sample} = ${sample};\n`, "utf8");
      const started = performance.now();
      await invalidateRepositoryIndex(repository, [{ path: relativePath, operation: "modify" }]);
      incrementalTimes.push(performance.now() - started);
      const delta = changedFileCount(before, readAffectedFiles(store, [relativePath]));
      filesScannedMax = Math.max(filesScannedMax, delta.changed);
      unrelatedPartitionChanges += delta.unrelated;
    }

    const batchMutations: Array<{ path: string; operation: "modify" }> = [];
    const batchPaths: string[] = [];
    for (let index = 0; index < Math.min(100, settings.files); index += 1) {
      const relativePath = `src/package-${String(index % 100).padStart(3, "0")}/file-${String(index).padStart(6, "0")}.ts`;
      fs.appendFileSync(path.join(repository, relativePath), `export const batchRevision${index} = ${index};\n`, "utf8");
      batchPaths.push(relativePath);
      batchMutations.push({ path: relativePath, operation: "modify" });
    }
    const batchBefore = readAffectedFiles(store, batchPaths);
    const batchStarted = performance.now();
    await invalidateRepositoryIndex(repository, batchMutations);
    const batch100Ms = performance.now() - batchStarted;
    const batchDelta = changedFileCount(batchBefore, readAffectedFiles(store, batchPaths));

    const queryTimes: number[] = [];
    for (let sample = 0; sample < settings.querySamples; sample += 1) {
      const query = `benchmarkSymbol${sample % settings.files}`;
      const started = performance.now();
      await retrieveRepositoryContext({ workspaceDir: repository, query, maxResults: 10, maxTokens: 20_000, semantic: { mode: "off" } });
      queryTimes.push(performance.now() - started);
    }

    const rssBytes = process.memoryUsage().rss;
    const indexBytes = directoryBytes(store.rootDir);
    const measurements = {
      coldMs: Number(coldMs.toFixed(3)),
      incrementalP95Ms: percentile(incrementalTimes, 0.95),
      batch100Ms: Number(batch100Ms.toFixed(3)),
      queryP95Ms: percentile(queryTimes, 0.95),
      queryP99Ms: percentile(queryTimes, 0.99),
      rssBytes,
    };
    const failures = [
      ...(measurements.coldMs <= settings.budgets.coldMs ? [] : [`cold index ${measurements.coldMs}ms > ${settings.budgets.coldMs}ms`]),
      ...(measurements.incrementalP95Ms <= settings.budgets.incrementalP95Ms ? [] : [`incremental p95 ${measurements.incrementalP95Ms}ms > ${settings.budgets.incrementalP95Ms}ms`]),
      ...(measurements.batch100Ms <= settings.budgets.batch100Ms ? [] : [`batch100 ${measurements.batch100Ms}ms > ${settings.budgets.batch100Ms}ms`]),
      ...(measurements.queryP95Ms <= settings.budgets.queryP95Ms ? [] : [`query p95 ${measurements.queryP95Ms}ms > ${settings.budgets.queryP95Ms}ms`]),
      ...(measurements.queryP99Ms <= settings.budgets.queryP99Ms ? [] : [`query p99 ${measurements.queryP99Ms}ms > ${settings.budgets.queryP99Ms}ms`]),
      ...(measurements.rssBytes <= settings.budgets.rssBytes ? [] : [`RSS ${measurements.rssBytes} > ${settings.budgets.rssBytes}`]),
      ...(filesScannedMax <= 1 ? [] : [`single-file invalidation changed ${filesScannedMax} indexed files`]),
      ...(unrelatedPartitionChanges === 0 ? [] : [`single-file invalidation removed ${unrelatedPartitionChanges} unrelated partitions`]),
      ...(batchDelta.changed <= 100 ? [] : [`batch100 invalidation changed ${batchDelta.changed} indexed files`]),
    ];
    return {
      schemaVersion: 1,
      profile,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      datasetDigest: digest(JSON.stringify(RETRIEVAL_REFERENCE_CASES)),
      treeDigest,
      engineSchemaDigest: digest("crewforge-repository-index-schema-v1"),
      scale: { files: settings.files, lines: settings.files * settings.linesPerFile, sourceBytes },
      cold: { elapsedMs: measurements.coldMs, indexedFiles: coldStatus.fileCount },
      incremental: {
        samples: incrementalTimes.length,
        p50Ms: percentile(incrementalTimes, 0.5),
        p95Ms: measurements.incrementalP95Ms,
        p99Ms: percentile(incrementalTimes, 0.99),
        filesScannedMax,
        unrelatedPartitionChanges,
      },
      batch100: { elapsedMs: measurements.batch100Ms, filesScanned: batchDelta.changed },
      query: {
        samples: queryTimes.length,
        p50Ms: percentile(queryTimes, 0.5),
        p95Ms: measurements.queryP95Ms,
        p99Ms: measurements.queryP99Ms,
      },
      rssBytes,
      indexBytes,
      budgets: settings.budgets,
      passed: failures.length === 0,
      failures,
    };
  } catch (error) {
    benchmarkFailure = error;
    throw error;
  } finally {
    if (ownsRoot) {
      try {
        await removeOwnedBenchmarkRoot(root);
      } catch (cleanupFailure) {
        if (benchmarkFailure !== undefined) {
          throw new AggregateError(
            [benchmarkFailure, cleanupFailure],
            "Retrieval benchmark failed and its owned temporary root could not be cleaned"
          );
        }
        throw cleanupFailure;
      }
    }
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(): Promise<void> {
  const requested = argument("--profile") || "smoke";
  if (requested !== "smoke" && requested !== "reference" && requested !== "large") throw new Error(`Unknown retrieval benchmark profile: ${requested}`);
  const report = await runRetrievalBenchmark({ profile: requested });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = argument("--json");
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), output, "utf8");
  }
  process.stdout.write(output);
  if (!report.passed && !process.argv.includes("--no-assert")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
