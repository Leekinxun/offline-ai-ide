import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { TraceStore } from "./traceStore.js";

function numericOption(name: string, positionalIndex: number, fallback: number): number { const optionIndex = process.argv.indexOf(name); const raw = optionIndex >= 0 ? process.argv[optionIndex + 1] : process.argv[positionalIndex]; const value = Number(raw); return Number.isFinite(value) ? value : fallback; }
const count = Math.max(1, Math.min(10_001, Math.floor(numericOption("--count", 2, 10_000))));
const repetitions = Math.max(1, Math.min(100, Math.floor(numericOption("--repetitions", 3, 20))));
const targetMs = Math.max(0.000001, numericOption("--max-ms", -1, 15_000));
const maxFlakyRate = Math.max(0.000001, Math.min(1, numericOption("--max-flaky-rate", -1, 0.01)));
const samples: Array<{ appendMs: number; listMs: number }> = [];
let lastMetrics: ReturnType<TraceStore["metrics"]> | undefined;
for (let repetition = 0; repetition < repetitions; repetition += 1) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-trace-bench-"));
  try {
    const store = new TraceStore(workspace, { maxEvents: 10_000, maxArchiveEvents: 10 });
    const appendStarted = performance.now();
    let parentEventId: string | undefined;
    for (let index = 0; index < count; index += 1) {
      const event = store.append({
        eventId: `bench-${index}`,
        timestamp: index + 1,
        kind: index % 2 ? "tool" : "agent",
        action: `event ${index}`,
        correlationId: index % 2 ? "odd" : "even",
        ...(index > 0 && index % 1_000 === 0 && parentEventId ? { parentEventId } : {}),
      });
      if (index % 1_000 === 0) parentEventId = event.eventId;
    }
    const appendMs = performance.now() - appendStarted;
    const listStarted = performance.now();
    const filteredCount = store.list({ correlationId: "even" }).length;
    const listMs = performance.now() - listStarted;
    if (filteredCount !== Math.ceil(count / 2)) throw new Error("Filtered trace count is incorrect");
    samples.push({ appendMs, listMs });
    lastMetrics = store.metrics();
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
function percentile(values: number[], quantile: number): number { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]; }
const append = samples.map(sample => sample.appendMs);
const list = samples.map(sample => sample.listMs);
const appendP95 = percentile(append, 0.95);
const appendMax = Math.max(...append);
const overTarget = append.filter(value => value >= targetMs).length;
const flakyRate = overTarget / repetitions;
const passed = appendP95 < targetMs && appendMax < targetMs && flakyRate < maxFlakyRate;
process.stdout.write(`${JSON.stringify({
  count,
  repetitions,
  appendMs: { p50: percentile(append, 0.5), p95: appendP95, max: appendMax, overTarget, flakyRate },
  listMs: { p50: percentile(list, 0.5), p95: percentile(list, 0.95), max: Math.max(...list) },
  metrics: lastMetrics,
  gate: { passed, targetMs, maxFlakyRate },
})}\n`);
if (!passed) process.exitCode = 2;
