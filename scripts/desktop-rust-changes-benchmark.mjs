import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { NativeIdeClient } from "../backend/dist/desktop/nativeIdeClient.js";
import { DesktopWorkspaceChanges } from "../backend/dist/desktop/nativeWorkspaceChanges.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const core = process.env.CROWNFORGE_TEST_NATIVE_IDE || path.join(project, "desktop/rust/target/debug", `crownforge-ide-core${process.platform === "win32" ? ".exe" : ""}`);
const counts = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [10_000, 100_000];
assert.ok(counts.length <= 2 && counts.every(count => count === 10_000 || count === 100_000), "Only 10000 and 100000 fixture sizes are accepted");
const results = [];

// The unchanged Web /changes traversal, measured alongside the desktop adapter
// on the same disposable workspace. Neither path includes HTTP overhead.
function legacyChanges(workspaceDir, since) {
  let latestMtime = 0, changed = false;
  const visit = fullPath => {
    if (changed) return;
    let entries;
    try { entries = fs.readdirSync(fullPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(fullPath, entry.name);
      let stat;
      try { stat = fs.statSync(absolutePath); } catch { continue; }
      latestMtime = Math.max(latestMtime, stat.mtimeMs);
      if (stat.mtimeMs > since) { changed = true; return; }
      if (entry.isDirectory()) { visit(absolutePath); if (changed) return; }
    }
  };
  latestMtime = fs.statSync(workspaceDir).mtimeMs;
  changed = latestMtime > since;
  if (!changed) visit(workspaceDir);
  return { changed, latestMtime: Math.max(latestMtime, since) };
}

async function measure(query) {
  const latency = [], timerDelay = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
    assert.equal((await query()).changed, false, "The idle fixture must remain unchanged during measurement");
    latency.push(performance.now() - start);
    timerDelay.push(await timer);
  }
  latency.sort((a, b) => a - b); timerDelay.sort((a, b) => a - b);
  return { samples: 20, p50Ms: latency[10], p95Ms: latency[18], eventLoopDelayP95Ms: timerDelay[18] };
}

for (const count of counts) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-changes-benchmark-")));
  let client;
  try {
    for (let i = 0; i < count; i++) {
      const directory = path.join(workspace, `d${Math.floor(i / 100)}`);
      if (i % 100 === 0) fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, `${i}.txt`), "fixture\n");
    }
    const since = Date.now() + 1_000;
    legacyChanges(workspace, since);
    const legacy = await measure(() => legacyChanges(workspace, since));
    client = new NativeIdeClient(core);
    const changes = new DesktopWorkspaceChanges((workspaceDir, after) => client.request("fs.changeVersion", { workspaceDir, ...(after ? { after } : {}) }));
    const initialStart = performance.now();
    let watermark = (await changes.read(workspace, since)).latestMtime;
    const watcherStartupMs = performance.now() - initialStart;
    await new Promise(resolve => setTimeout(resolve, 300));
    watermark = (await changes.read(workspace, watermark)).latestMtime;
    const native = await measure(() => changes.read(workspace, watermark));
    results.push({ fileCount: count, watcherStartupMs, legacy, native });
  } finally {
    client?.close();
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const report = { capturedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version,
  method: "Idle workspace, warm filesystem cache; unchanged Web traversal versus desktop native cursor RPC including Node projection; no HTTP overhead", results };
const reportPath = path.join(project, ".artifacts/app-rust/changes-benchmark.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
