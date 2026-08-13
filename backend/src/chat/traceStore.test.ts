import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getTraceRetention, setTraceRetention, TraceStore } from "./traceStore.js";

test("trace store redacts, strips reasoning, validates parents and retains bounded history", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-trace-"));
  const store = new TraceStore(workspace, { maxEvents: 3, maxArchiveEvents: 2 });
  const root = store.append({ kind: "run", action: "start", correlationId: "run", metadata: { thinking: "private", safe: "yes", nested: { prompt: "private", retained: true, values: [{ raw_output: "private" }] } } });
  store.append({ kind: "tool", action: "call sk-test_TRACE_123456", correlationId: "run", parentEventId: root.eventId });
  assert.throws(() => store.append({ kind: "tool", action: "bad", correlationId: "run", parentEventId: "missing" }), /parent/);
  const initial = JSON.stringify(store.export());
  assert.doesNotMatch(initial, /thinking|prompt|raw_output/);
  assert.match(initial, /retained/);
  for (let index = 0; index < 4; index += 1) store.append({ kind: "agent", action: `step ${index}`, correlationId: "run" });
  const exported = JSON.stringify(store.export());
  assert.doesNotMatch(exported, /sk-test_TRACE_123456/);
  assert.doesNotMatch(exported, /thinking|prompt|raw_output/);
  assert.ok(store.metrics().eventCount <= 3);
  assert.ok(store.metrics().archivedEventCount <= 2);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("workspace retention policy persists and previews age/count pruning", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-trace-policy-"));
  assert.equal(setTraceRetention(workspace, { maxEvents: 2, maxArchiveEvents: 1, maxAgeMs: 1_000, maxArchiveAgeMs: 2_000 }).maxEvents, 2);
  assert.equal(getTraceRetention(workspace).maxArchiveEvents, 1);
  const store = new TraceStore(workspace);
  const now = Date.now();
  store.append({ kind: "run", action: "old", correlationId: "run", timestamp: now - 5_000 });
  store.append({ kind: "run", action: "new", correlationId: "run", timestamp: now });
  const preview = store.previewPrune(now);
  assert.equal(preview.hotAfter, 1);
  assert.equal(store.prune(now).hotAfter, 1);
  assert.equal(store.metrics().eventCount, 1);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("10,000 mixed causal events stay responsive, durable, ordered, redacted, and bounded", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-trace-10k-"));
  setTraceRetention(workspace, {
    maxEvents: 10_000,
    maxArchiveEvents: 2,
    maxAgeMs: 0,
    maxArchiveAgeMs: 0,
    archive: true,
  });
  const store = new TraceStore(workspace);
  const kinds = ["run", "agent", "model", "tool", "approval", "checkpoint", "validation", "git", "review", "decision"] as const;
  const timestampBase = Date.now();
  let causalParent: string | undefined;
  for (let index = 0; index < 10_000; index += 1) {
    const event = store.append({
      eventId: `bulk-${index.toString().padStart(5, "0")}`,
      timestamp: timestampBase + index,
      kind: kinds[index % kinds.length],
      action: index === 9_999 ? "secret sk-test_TRACE_BULK_123456" : `event ${index}`,
      correlationId: index % 2 === 0 ? "bulk-even" : "bulk-odd",
      ...(index > 0 && index % 1_000 === 0 && causalParent ? { parentEventId: causalParent } : {}),
      metadata: index === 9_999 ? { nested: { reasoning: "private", retained: "safe" } } : undefined,
    });
    if (index % 1_000 === 0) causalParent = event.eventId;
  }
  const metrics = store.metrics();
  assert.equal(metrics.eventCount, 10_000);
  assert.equal(metrics.archivedEventCount, 0);
  assert.ok(metrics.totalBytes < 15_000_000, `trace storage unexpectedly large: ${metrics.totalBytes}`);
  const listed = store.list();
  assert.equal(listed[0]?.eventId, "bulk-00000");
  assert.equal(listed.at(-1)?.eventId, "bulk-09999");
  assert.equal(listed[1_000]?.parentEventId, "bulk-00000");

  const restarted = new TraceStore(workspace);
  assert.equal(restarted.list({ correlationId: "bulk-even" }).length, 5_000);
  const exported = JSON.stringify(restarted.export({ correlationId: "bulk-odd" }));
  assert.doesNotMatch(exported, /sk-test_TRACE_BULK_123456|reasoning|private/);
  assert.match(JSON.stringify(restarted.export()), /retained/);

  restarted.append({ eventId: "bulk-10000", timestamp: timestampBase + 10_000, kind: "error", action: "overflow", correlationId: "bulk-even" });
  const overflowMetrics = restarted.metrics();
  assert.equal(overflowMetrics.eventCount, 10_000);
  assert.equal(overflowMetrics.archivedEventCount, 1);
  assert.ok(overflowMetrics.eventCount <= restarted.getRetention().maxEvents);
  assert.ok(overflowMetrics.archivedEventCount <= restarted.getRetention().maxArchiveEvents);
  assert.equal(restarted.list()[0]?.eventId, "bulk-00001");
  assert.equal(restarted.list().at(-1)?.eventId, "bulk-10000");
  await fs.rm(workspace, { recursive: true, force: true });
});

test("a stale lock from a confirmed-dead owner is recovered", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-trace-dead-lock-"));
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = child.pid;
  assert.ok(deadPid);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  const lock = path.join(workspace, ".history", "traces", ".events.lock");
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ pid: deadPid, token: "dead-owner", createdAt: Date.now() - 10_000 }));
  const event = new TraceStore(workspace).append({ kind: "run", action: "recovered", correlationId: "dead-lock" });
  assert.equal(event.action, "recovered");
  await assert.rejects(fs.access(lock));
  await fs.rm(workspace, { recursive: true, force: true });
});

test("a stale-looking live owner is never stolen", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-trace-live-lock-"));
  const lock = path.join(workspace, ".history", "traces", ".events.lock");
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const owner = { pid: process.pid, token: "live-owner", createdAt: Date.now() - 10_000 };
  await fs.writeFile(lock, JSON.stringify(owner));
  assert.throws(() => new TraceStore(workspace).append({ kind: "run", action: "must wait", correlationId: "live-lock" }), /busy/);
  assert.deepEqual(JSON.parse(await fs.readFile(lock, "utf8")), owner);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("cross-process concurrent appends do not lose events", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crewforge-trace-concurrent-"));
  const moduleUrl = pathToFileURL(path.resolve("src/chat/traceStore.ts")).href;
  const runWriter = (prefix: string) => new Promise<void>((resolve, reject) => {
    const script = `import { TraceStore } from ${JSON.stringify(moduleUrl)}; const store = new TraceStore(${JSON.stringify(workspace)}); for (let i = 0; i < 100; i += 1) store.append({ eventId: ${JSON.stringify(prefix)} + i, kind: "agent", action: "concurrent", correlationId: ${JSON.stringify(prefix)} });`;
    const writer = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: path.resolve(".") });
    let stderr = "";
    writer.stderr.on("data", chunk => { stderr += String(chunk); });
    writer.once("error", reject);
    writer.once("close", code => code === 0 ? resolve() : reject(new Error(`writer ${prefix} exited ${code}: ${stderr}`)));
  });
  await Promise.all([runWriter("a-"), runWriter("b-")]);
  const events = new TraceStore(workspace).list();
  assert.equal(events.length, 200);
  assert.equal(new Set(events.map(event => event.eventId)).size, 200);
  assert.equal(events.filter(event => event.correlationId === "a-").length, 100);
  assert.equal(events.filter(event => event.correlationId === "b-").length, 100);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("benchmark CLI reports and enforces its release-gate contract", async () => {
  const benchmark = path.resolve("src/chat/traceStore.bench.ts");
  const run = (maxMs: number) => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", benchmark, "--count", "100", "--repetitions", "2", "--max-ms", String(maxMs), "--max-flaky-rate", "0.01"]);
    let stdout = ""; child.stdout.on("data", chunk => { stdout += String(chunk); }); child.once("error", reject); child.once("close", code => resolve({ code, stdout }));
  });
  const passing = await run(15_000); const passReport = JSON.parse(passing.stdout) as { gate: { passed: boolean; targetMs: number; maxFlakyRate: number } };
  assert.equal(passing.code, 0); assert.deepEqual(passReport.gate, { passed: true, targetMs: 15_000, maxFlakyRate: 0.01 });
  const failing = await run(0.0001); const failReport = JSON.parse(failing.stdout) as { gate: { passed: boolean } };
  assert.equal(failing.code, 2); assert.equal(failReport.gate.passed, false);
});
