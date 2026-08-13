import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { TraceStore } from "../backend/src/chat/traceStore.js";

function option(name: string, fallback: number): number { const index = process.argv.indexOf(name); const parsed = Number(index >= 0 ? process.argv[index + 1] : Number.NaN); return Number.isFinite(parsed) ? parsed : fallback; }
const prefill = Math.max(1, Math.min(10_000, Math.floor(option("--prefill", 10_000))));
const repetitions = Math.max(2, Math.min(100, Math.floor(option("--repetitions", 20))));
const maxP95Ms = Math.max(0.001, option("--max-p95-ms", 15_000));
const maxMs = Math.max(0.001, option("--max-ms", 15_000));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-trace-overflow-"));
const samples: number[] = [];
let metrics;
try {
  const store = new TraceStore(workspace, { maxEvents: prefill, maxArchiveEvents: repetitions + 10, archive: true });
  for (let index = 0; index < prefill; index += 1) store.append({ eventId: `prefill-${index}`, timestamp: index + 1, kind: "agent", action: `prefill ${index}`, correlationId: "overflow-benchmark" });
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    store.append({ eventId: `overflow-${index}`, timestamp: prefill + index + 1, kind: "tool", action: `overflow ${index}`, correlationId: "overflow-benchmark" });
    samples.push(performance.now() - started);
  }
  metrics = store.metrics();
} finally { fs.rmSync(workspace, { recursive: true, force: true }); }

function percentile(values: number[], quantile: number): number { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]; }
const p50 = percentile(samples, 0.5); const p95 = percentile(samples, 0.95); const maximum = Math.max(...samples);
const invariants = { hotRetentionBounded: metrics?.eventCount === prefill, everyOverflowArchived: metrics?.archivedEventCount === repetitions };
const passed = p95 < maxP95Ms && maximum < maxMs && Object.values(invariants).every(Boolean);
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: "crewforge-trace-overflow-benchmark", prefill, repetitions, appendMs: { p50, p95, max: maximum }, metrics, invariants, gate: { passed, maxP95Ms, maxMs } })}\n`);
if (!passed) process.exitCode = 2;
