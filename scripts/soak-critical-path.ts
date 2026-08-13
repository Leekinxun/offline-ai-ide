import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { runCriticalPathIteration } from "./ws15CriticalPath.js";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const iterations = Number.parseInt(argument("--iterations", "100"), 10);
if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > 1000) throw new Error("--iterations must be an integer from 1 to 1000");
const reportDir = path.resolve(argument("--report-dir", process.env.WS15_REPORT_DIR || path.join(process.cwd(), ".artifacts", "ws15")));
fs.mkdirSync(reportDir, { recursive: true });

const startedAt = new Date().toISOString();
const started = performance.now();
const results: Array<{ iteration: number; passed: boolean; durationMs: number; error?: string }> = [];
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const iterationStarted = performance.now();
  try {
    runCriticalPathIteration();
    results.push({ iteration, passed: true, durationMs: Number((performance.now() - iterationStarted).toFixed(3)) });
  } catch (error) {
    results.push({ iteration, passed: false, durationMs: Number((performance.now() - iterationStarted).toFixed(3)), error: error instanceof Error ? error.message : String(error) });
  }
}

const failed = results.filter((result) => !result.passed).length;
const flakyRate = failed / iterations;
const report = {
  schemaVersion: 1,
  kind: "crewforge-ws15-critical-path-soak",
  startedAt,
  completedAt: new Date().toISOString(),
  durationMs: Number((performance.now() - started).toFixed(3)),
  iterations,
  passed: iterations - failed,
  failed,
  flakyRate,
  gate: { thresholdExclusive: 0.01, passed: flakyRate < 0.01 && iterations === 100 },
  criticalPaths: ["modal-topmost-escape", "visible-tree-navigation", "secret-redaction", "migration-exact-backup-rollback", "corrupt-journal-recovery"],
  results,
};
const reportPath = path.join(reportDir, "soak-report.json");
const temporary = `${reportPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, reportPath);
process.stdout.write(`WS-15 critical-path soak: ${report.passed}/${iterations} passed, flakyRate=${(flakyRate * 100).toFixed(2)}%, duration=${report.durationMs}ms\n`);
process.stdout.write(`Report: ${reportPath}\n`);
if (!report.gate.passed) process.exitCode = 1;
