import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { assertMandatoryTestMarkers, discoverBackendTests } from "./release-methodology.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.WS15_CLEAN_SNAPSHOT !== "1" || process.env.WS15_OFFLINE_GUARD !== "1") {
  process.stderr.write("WS-15 release verification must run through scripts/verify.sh in a complete clean snapshot with the scoped Node egress guard enabled.\n");
  process.exit(1);
}
const backend = path.join(root, "backend"); const frontend = path.join(root, "frontend");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "scripts", "fixtures", "ws15-release-contract.json"), "utf8"));
assertMandatoryTestMarkers(root, fixture);
const reportDir = path.resolve(process.env.WS15_REPORT_DIR || path.join(root, ".artifacts", "ws15"));
fs.mkdirSync(reportDir, { recursive: true });

function testFiles() { return discoverBackendTests(backend); }

function tapSummary(output) {
  const value = (label) => Number(output.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1] ?? Number.NaN);
  return { tests: value("tests"), passed: value("pass"), failed: value("fail"), skipped: value("skipped") };
}

const gates = [];
async function runGate(input) {
  const startedAt = new Date().toISOString(); const started = performance.now(); let output = ""; let stdout = "";
  process.stdout.write(`\n[WS-15] ${input.name}\n`);
  const result = await new Promise((resolve) => {
    const child = spawn(input.command, input.args || [], { cwd: input.cwd || root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (stream, target, isStdout = false) => stream.on("data", (chunk) => { const text = chunk.toString(); output = `${output}${text}`.slice(-2_000_000); if (isStdout) stdout = `${stdout}${text}`.slice(-2_000_000); target.write(text); });
    collect(child.stdout, process.stdout, true); collect(child.stderr, process.stderr);
    child.on("error", (error) => resolve({ status: 1, signal: null, error: error.message }));
    child.on("close", (status, signal) => resolve({ status: status ?? 1, signal, error: null }));
  });
  const tap = input.tap ? tapSummary(output) : undefined;
  let machineReport;
  if (input.machineReportName) {
    try {
      const jsonLine = stdout.trim().split("\n").filter(Boolean).at(-1);
      machineReport = JSON.parse(jsonLine || "");
      const reportPath = path.join(reportDir, input.machineReportName); const temporary = `${reportPath}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(machineReport, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, reportPath);
    } catch (error) { result.status = 1; result.error = `invalid machine report: ${error instanceof Error ? error.message : String(error)}`; }
  }
  const noSkipPassed = !input.noSkips || (tap && tap.tests > 0 && tap.skipped === 0 && tap.failed === 0 && tap.passed === tap.tests);
  const machineReportPassed = !input.machineReportName || machineReport?.gate?.passed === true;
  const passed = result.status === 0 && noSkipPassed && machineReportPassed;
  const gate = {
    name: input.name, category: input.category, mandatory: Boolean(input.mandatory),
    command: [input.command, ...(input.args || [])], cwd: path.relative(root, input.cwd || root) || ".",
    startedAt, durationMs: Number((performance.now() - started).toFixed(3)), status: result.status,
    signal: result.signal, error: result.error, tap, machineReport, passed,
  };
  gates.push(gate);
  if (!passed) throw new Error(`${input.name} failed${input.noSkips ? " or skipped a mandatory test" : ""}`);
}

const startedAt = new Date().toISOString(); const started = performance.now(); let failure = null;
const mandatoryNames = ["node-egress-guard", "release-methodology", "strict-static-quality", "mandatory-security", "mandatory-migration-recovery", "browserless-e2e-contracts", "critical-loop-100", "performance-context", "performance-retrieval", "performance-trace", "performance-trace-overflow", "frontend-bundle-budget", "critical-path-soak", "ws15-release-contract"];
try {
  await runGate({ name: "node-egress-guard", category: "guarded-node-tcp-http-fetch", mandatory: true, command: process.execPath, args: ["scripts/offline-network-guard-self-test.mjs"] });
  await runGate({ name: "release-methodology", category: "release-methodology", mandatory: true, command: process.execPath, args: ["--test", "scripts/release-methodology.test.mjs"], tap: true, noSkips: true });
  await runGate({ name: "backend-unit-integration", category: "unit-integration", command: process.execPath, args: ["--import", "tsx", "--test", "--test-concurrency=1", ...testFiles()], cwd: backend, tap: true });
  await runGate({ name: "backend-typecheck", category: "build", command: "npm", args: ["run", "build"], cwd: backend });
  await runGate({ name: "strict-static-quality", category: "static-quality", mandatory: true, command: process.execPath, args: ["scripts/strict-static-quality.mjs"], machineReportName: "strict-static-quality-report.json" });
  await runGate({ name: "mandatory-security", category: "security", mandatory: true, command: process.execPath, args: ["--import", "tsx", "--test", "--test-concurrency=1", ...fixture.mandatorySecurityTests], cwd: backend, tap: true, noSkips: true });
  await runGate({ name: "mandatory-migration-recovery", category: "migration-backup-restore-corrupt-recovery", mandatory: true, command: process.execPath, args: ["--import", "tsx", "--test", "--test-concurrency=1", ...fixture.mandatoryRecoveryTests], cwd: backend, tap: true, noSkips: true });
  await runGate({ name: "browserless-e2e-contracts", category: "e2e-like-browserless", mandatory: true, command: process.execPath, args: ["--import", "tsx", "--test", "../scripts/changeSetRecovery.test.ts", "../scripts/jsonTree.test.ts", "../scripts/fileTreeNavigation.test.ts", "../scripts/frontendFlows.test.ts", "../scripts/frontendVisualLocale.test.ts", "../scripts/safeExternalLink.test.ts", "../scripts/ws15CriticalPath.test.ts"], cwd: backend, tap: true, noSkips: true });
  await runGate({ name: "critical-loop-100", category: "browserless-critical-loop", mandatory: true, command: "bash", args: ["scripts/ws15-critical-loop.sh", "--iterations", "100"] });
  await runGate({ name: "frontend-flow-contract", category: "e2e-like-browserless", command: process.execPath, args: ["scripts/ws15-frontend-flow-contract.mjs"] });
  await runGate({ name: "performance-context", category: "performance", mandatory: true, command: process.execPath, args: ["--import", "tsx", "src/agent/benchmark.ts"], cwd: backend });
  await runGate({ name: "performance-retrieval", category: "performance", mandatory: true, command: process.execPath, args: ["--import", "tsx", "src/indexing/retrievalBenchmark.ts", "--profile", "smoke", "--assert"], cwd: backend });
  await runGate({ name: "performance-trace", category: "performance", mandatory: true, command: process.execPath, args: ["--import", "tsx", "src/chat/traceStore.bench.ts", "--count", "10000", "--repetitions", "100", "--max-ms", "15000", "--max-flaky-rate", "0.01"], cwd: backend, machineReportName: "trace-performance-report.json" });
  await runGate({ name: "performance-trace-overflow", category: "performance-steady-state-retention", mandatory: true, command: process.execPath, args: ["--import", "tsx", "../scripts/traceOverflowBenchmark.ts", "--prefill", String(fixture.traceOverflowBudget.prefill), "--repetitions", String(fixture.traceOverflowBudget.repetitions), "--max-p95-ms", String(fixture.traceOverflowBudget.maxP95Ms), "--max-ms", String(fixture.traceOverflowBudget.maxMs)], cwd: backend, machineReportName: "trace-overflow-report.json" });
  await runGate({ name: "frontend-production-build", category: "build", command: "npm", args: ["run", "build"], cwd: frontend });
  await runGate({ name: "frontend-bundle-budget", category: "bundle-size", mandatory: true, command: process.execPath, args: ["scripts/frontend-bundle-budget.mjs"], machineReportName: "bundle-budget-report.json" });
  await runGate({ name: "ui-contracts", category: "e2e-like-browserless", command: "bash", args: ["scripts/ui-contract.sh"] });
  await runGate({ name: "ws14-release-contract", category: "release-contract", command: process.execPath, args: ["scripts/ws14-release-contract.mjs"] });
  await runGate({ name: "critical-path-soak", category: "soak", mandatory: true, command: process.execPath, args: ["--import", "tsx", "../scripts/soak-critical-path.ts", "--iterations", "100", "--report-dir", reportDir], cwd: backend });
  await runGate({ name: "ws15-release-contract", category: "release-contract", mandatory: true, command: process.execPath, args: ["scripts/ws15-release-contract.mjs"] });
} catch (error) { failure = error instanceof Error ? error.message : String(error); }

const missingMandatory = mandatoryNames.filter((name) => !gates.some((gate) => gate.name === name && gate.mandatory && gate.passed));
const passed = !failure && missingMandatory.length === 0 && gates.every((gate) => gate.passed);
const report = {
  schemaVersion: 1, kind: "crewforge-ws15-release-verification", startedAt, completedAt: new Date().toISOString(),
  durationMs: Number((performance.now() - started).toFixed(3)), cleanSnapshotDigest: process.env.WS15_CLEAN_SNAPSHOT_DIGEST || null,
  nodeEgressGuardEnabled: process.env.WS15_OFFLINE_GUARD === "1", npmOfflineMode: process.env.npm_config_offline === "true", passed, failure, missingMandatory, gates,
  limitations: [
    "The verification guard covers Node net.Socket TCP connects, node:http, node:https, and global fetch; loopback is allowed for integration fixtures.",
    "The guard does not prove DNS, UDP, raw-socket, native-binary, child-process, or other non-Node egress isolation; npm offline mode and loopback proxy settings are additional controls, not an OS network sandbox.",
    "Preinstalled dependencies are reused through host symlinks, are not included in the clean-source digest, and are not installed or downloaded during verification.",
    "UI acceptance is browserless/static and does not replace live browser, screen-reader, or device testing.",
    "Docker image smoke testing is separate because it requires a container daemon and prebuilt/offline image inputs.",
    "Platform-conditional skips are allowed only in the general backend suite; mandatory security, migration/recovery, browserless, performance, Node-egress-guard, bundle, critical-loop, and soak gates cannot skip."
  ],
};
const reportPath = path.join(reportDir, "release-report.json"); const temporary = `${reportPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, reportPath);
process.stdout.write(`\nWS-15 release verification ${passed ? "passed" : "failed"} in ${(report.durationMs / 1000).toFixed(2)}s.\nReport: ${reportPath}\n`);
if (!passed) process.exitCode = 1;
