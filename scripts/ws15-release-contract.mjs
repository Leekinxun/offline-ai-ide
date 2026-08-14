import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMandatoryTestMarkers, discoverBackendTests } from "./release-methodology.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "scripts", "fixtures", "ws15-release-contract.json"), "utf8"));
const failures = [];
const read = (relative) => { try { return fs.readFileSync(path.join(root, relative), "utf8"); } catch { failures.push(`missing readable file ${relative}`); return ""; } };
if (fixture.schemaVersion !== 1) failures.push("unsupported fixture schemaVersion");
for (const relative of fixture.requiredReleaseFiles) if (!fs.existsSync(path.join(root, relative))) failures.push(`missing release surface ${relative}`);

const releaseSources = ["scripts/verify-release.sh", "scripts/verify-release.mjs", "scripts/verify-clean-snapshot.mjs", "scripts/release-methodology.mjs", "scripts/strict-static-quality.mjs", "scripts/frontend-bundle-budget.mjs", "scripts/traceOverflowBenchmark.ts", "scripts/ws15-critical-loop.sh", "scripts/soak-critical-path.ts"].map(read).join("\n");
for (const token of fixture.requiredReleaseTokens) if (!releaseSources.includes(token)) failures.push(`release flow is missing ${JSON.stringify(token)}`);
for (const token of ["WS15_CLEAN_SNAPSHOT", "WS15_OFFLINE_GUARD", "nodeEgressGuardEnabled", "npmOfflineMode"]) if (!read("scripts/verify-release.mjs").includes(token)) failures.push(`release runner does not require ${token}`);
if (!read("scripts/verify.sh").includes("verify-release.sh")) failures.push("scripts/verify.sh must delegate to the release verifier");
const discoveredTests = discoverBackendTests(path.join(root, "backend"));
for (const required of ["src/collaboration/collaborationStore.test.ts", "src/config.test.ts", "src/utils/safePath.test.ts", "src/ws/terminal.test.ts"]) if (!discoveredTests.includes(required)) failures.push(`recursive backend discovery omitted ${required}`);

for (const group of [fixture.mandatorySecurityTests, fixture.mandatoryRecoveryTests]) {
  if (!Array.isArray(group) || group.length === 0) failures.push("mandatory test group is empty");
  for (const relative of group || []) if (!fs.existsSync(path.join(root, "backend", relative))) failures.push(`mandatory test is missing: backend/${relative}`);
}
try { assertMandatoryTestMarkers(root, fixture); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
for (const required of [".git", ".history", ".checkpoints", ".team", ".codex", "users.json", "app-settings.json", "workspace"]) {
  if (!fixture.snapshot.excludedRootEntries.includes(required)) failures.push(`clean snapshot does not exclude ${required}`);
}
for (const dependency of fixture.snapshot.dependencyLinks) if (!dependency.endsWith("/node_modules")) failures.push(`unexpected dependency link ${dependency}`);

const cleanSource = read("scripts/verify-clean-snapshot.mjs");
for (const token of ["WS15_OFFLINE_GUARD", "npm_config_offline", "WS15_NETWORK_AUDIT_FILE", "unexpectedExternalAttempts", "clean-snapshot-manifest.json", "Source changed during clean-snapshot copy", "Git tracked/untracked source inventory changed", "git-tracked-baseline-plus-intended-worktree", "collectGitSourceInventory", "assertSnapshotCompleteness", "protectedArtifactsUntouched", "artifactFingerprint(\".history\")", "artifactFingerprint(\".checkpoints\")", "preinstalled-host-symlinks", "notCovered", "DNS", "UDP", "native binaries", "git", "diff", "--check"]) if (!cleanSource.includes(token)) failures.push(`clean snapshot verifier is missing ${token}`);
const guardSource = read("scripts/offline-network-guard.mjs");
for (const token of ["WS15_EXTERNAL_NETWORK_DENIED", "127", "::1", "external_egress_blocked", "Socket.prototype.connect", "globalThis.fetch"]) if (!guardSource.includes(token)) failures.push(`Node egress guard is missing ${token}`);
const guardTestSource = read("scripts/offline-network-guard-self-test.mjs");
for (const token of ["net.connect", "http.get", "https.get", "fetch", "loopback-ok"]) if (!guardTestSource.includes(token)) failures.push(`Node egress guard self-test is missing ${token}`);
const soakSource = read("scripts/soak-critical-path.ts");
for (const token of ["thresholdExclusive: 0.01", "iterations === 100", "soak-report.json", "flakyRate"]) if (!soakSource.includes(token)) failures.push(`soak gate is missing ${token}`);
const releaseSource = read("scripts/verify-release.mjs");
if (releaseSource.includes("offlineGuard:")) failures.push("release report must not overclaim a general offline guard");
for (const token of ["traceStore.bench.ts", "--repetitions", "100", "--max-ms", "15000", "--max-flaky-rate", "0.01", "trace-performance-report.json", "performance-trace-overflow", "traceOverflowBenchmark.ts", "trace-overflow-report.json", "critical-loop-100", "ws15-critical-loop.sh", "frontend-bundle-budget", "bundle-budget-report.json", "machineReport?.gate?.passed === true"]) if (!releaseSource.includes(token)) failures.push(`release gate is missing ${token}`);
const criticalLoopSource = read("scripts/ws15-critical-loop.sh");
for (const token of ["--iterations", "100", "# fail 0", "# skipped 0"]) if (!criticalLoopSource.includes(token)) failures.push(`critical loop gate is missing ${token}`);
if (fixture.frontendBundleBudget.mainShellMaxBytes <= 0 || fixture.frontendBundleBudget.otherJavaScriptMaxBytes <= 0) failures.push("frontend bundle budgets must be positive");
if (fixture.frontendBundleBudget.exceptions.length !== 2 || !fixture.frontendBundleBudget.exceptions.every((item) => item.pattern.includes("monaco") || item.pattern.includes("worker"))) failures.push("bundle budget exceptions must be limited to explicit Monaco core/worker patterns");
if (fixture.traceOverflowBudget.prefill !== 10000 || fixture.traceOverflowBudget.repetitions < 2 || fixture.traceOverflowBudget.maxP95Ms <= 0 || fixture.traceOverflowBudget.maxMs <= 0) failures.push("trace overflow budget must prefill 10k and bound repeated overflow p95/max");
const evidenceDoc = read("docs/verification/release-evidence.md"); const migrationsDoc = read("docs/migrations/storage-migrations.md");
if (evidenceDoc.includes("Invalid state can fall back empty")) failures.push("release evidence retains stale collaboration corruption fallback claim");
if (migrationsDoc.includes("Missing/invalid state falls back to an empty state")) failures.push("migration docs retain stale collaboration corruption fallback claim");
const gitignore = read(".gitignore");
for (const runtime of [".history/", ".checkpoints/"]) if (!gitignore.split("\n").includes(runtime)) failures.push(`.gitignore must ignore runtime directory ${runtime}`);
const composeSource = read("docker-compose.yml");
if (/^\s+pull:\s/m.test(composeSource) || /^\s+pull_policy:\s/m.test(composeSource)) failures.push("docker-compose.yml must remain compatible with docker-compose v1 and must not use build.pull or pull_policy");
for (const token of ["crownforge-permissions:", "command: [\"init-mounts\"]", "cap_add:", "- CHOWN", "depends_on:", "- crownforge-permissions", "user: \"${CROWNFORGE_UID:-10001}:${CROWNFORGE_GID:-10001}\"", "CROWNFORGE_UID=${CROWNFORGE_UID:-10001}", "CROWNFORGE_GID=${CROWNFORGE_GID:-10001}"]) if (!composeSource.includes(token)) failures.push(`docker-compose.yml is missing automatic mount initialization token ${JSON.stringify(token)}`);
const dockerEntrypoint = read("scripts/docker-entrypoint.sh");
for (const token of ["chown \"$runtime_uid:$runtime_gid\" /workspace /app/plugins", "init-mounts", "setpriv", "--no-new-privs"]) if (!dockerEntrypoint.includes(token)) failures.push(`Docker entrypoint is missing mount initialization boundary ${JSON.stringify(token)}`);
for (const readme of [read("README.md"), read("README_zh.md")]) if (!readme.includes("docker-compose up -d --build")) failures.push("README Compose instructions must include the docker-compose v1 command");
if (/rm\s+-rf/.test(releaseSources)) failures.push("release scripts must not use broad destructive cleanup");

if (failures.length) {
  process.stderr.write(`WS-15 release contract found ${failures.length} gap(s):\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else process.stdout.write("CrewForge WS-15 release contract passed.\n");
