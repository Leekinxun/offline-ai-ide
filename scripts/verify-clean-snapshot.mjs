import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { assertSnapshotCompleteness, collectGitSourceInventory, snapshotPathExcluded } from "./release-methodology.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(sourceRoot, "scripts", "fixtures", "ws15-release-contract.json"), "utf8"));
if (fixture.schemaVersion !== 1) throw new Error("Unsupported WS-15 release fixture schema");
const reportDir = path.resolve(process.env.WS15_REPORT_DIR || path.join(sourceRoot, ".artifacts", "ws15"));
fs.mkdirSync(reportDir, { recursive: true });
const networkAuditFile = path.join(reportDir, "network-audit.ndjson");
fs.writeFileSync(networkAuditFile, "", { mode: 0o600 });

const commandSeparator = process.argv.indexOf("--");
const command = commandSeparator >= 0 ? process.argv.slice(commandSeparator + 1) : ["bash", "scripts/verify-release.sh", "--inside-clean-snapshot"];
if (!command.length) throw new Error("A clean-snapshot verification command is required");

function artifactFingerprint(relative) {
  const target = path.join(sourceRoot, relative);
  if (!fs.existsSync(target)) return { exists: false, digest: null, entries: 0 };
  const records = [];
  const visit = (current, nested = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name); const relativePath = normalize(path.join(nested, entry.name)); const stat = fs.lstatSync(absolute);
      if (entry.isSymbolicLink()) records.push({ path: relativePath, type: "symlink", target: fs.readlinkSync(absolute), mode: stat.mode & 0o777 });
      else if (entry.isDirectory()) { records.push({ path: relativePath, type: "directory", mode: stat.mode & 0o777 }); visit(absolute, path.join(nested, entry.name)); }
      else if (entry.isFile()) records.push({ path: relativePath, type: "file", size: stat.size, mode: stat.mode & 0o777, sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") });
      else records.push({ path: relativePath, type: "other", mode: stat.mode & 0o777 });
    }
  };
  visit(target);
  return { exists: true, digest: crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex"), entries: records.length };
}

const normalize = (value) => value.split(path.sep).join("/");
function excluded(relative) { return snapshotPathExcluded(relative, fixture); }

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-ws15-clean-"));
const snapshotRoot = path.join(temporaryRoot, "snapshot");
fs.mkdirSync(snapshotRoot);
const manifestEntries = [];
function copyDirectory(sourceDirectory, targetDirectory, relativeDirectory = "") {
  const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    if (excluded(relative, entry)) continue;
    const source = path.join(sourceDirectory, entry.name); const target = path.join(targetDirectory, entry.name); const normalized = normalize(relative);
    if (entry.isSymbolicLink()) throw new Error(`Clean snapshot refuses included symlink: ${normalized}`);
    if (entry.isDirectory()) { fs.mkdirSync(target, { recursive: true }); copyDirectory(source, target, relative); continue; }
    if (!entry.isFile()) throw new Error(`Clean snapshot refuses non-file entry: ${normalized}`);
    const bytes = fs.readFileSync(source); const mode = fs.statSync(source).mode & 0o777;
    fs.copyFileSync(source, target); fs.chmodSync(target, mode);
    manifestEntries.push({ path: normalized, size: bytes.length, mode: mode.toString(8).padStart(3, "0"), sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  }
}
function scanDirectory(sourceDirectory, relativeDirectory = "", results = []) {
  const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    if (excluded(relative, entry)) continue;
    const source = path.join(sourceDirectory, entry.name); const normalized = normalize(relative);
    if (entry.isSymbolicLink()) throw new Error(`Clean snapshot refuses included symlink: ${normalized}`);
    if (entry.isDirectory()) { scanDirectory(source, relative, results); continue; }
    if (!entry.isFile()) throw new Error(`Clean snapshot refuses non-file entry: ${normalized}`);
    const bytes = fs.readFileSync(source); const mode = fs.statSync(source).mode & 0o777;
    results.push({ path: normalized, size: bytes.length, mode: mode.toString(8).padStart(3, "0"), sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  }
  return results;
}

const startedAt = new Date().toISOString(); const started = performance.now();
const protectedArtifactsBefore = { history: artifactFingerprint(".history"), checkpoints: artifactFingerprint(".checkpoints") };
let exitCode = 1; let signal = null; let diffCheck = { passed: false, status: null, error: null }; let cleanup = { attempted: false, passed: false };
let sourceInventory; let snapshotCompleteness;
let manifestDigest = "";
try {
  const diff = spawnSync("git", ["-C", sourceRoot, "diff", "--check"], { stdio: "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  diffCheck = { passed: diff.status === 0, status: diff.status, error: diff.error?.message || null };
  if (!diffCheck.passed) throw new Error(`git diff --check failed: ${diff.error?.message || diff.status}`);

  sourceInventory = collectGitSourceInventory(sourceRoot, fixture);
  copyDirectory(sourceRoot, snapshotRoot);
  manifestDigest = crypto.createHash("sha256").update(JSON.stringify(manifestEntries)).digest("hex");
  const sourceAfterCopy = scanDirectory(sourceRoot);
  const sourceAfterCopyDigest = crypto.createHash("sha256").update(JSON.stringify(sourceAfterCopy)).digest("hex");
  if (sourceAfterCopyDigest !== manifestDigest) throw new Error("Source changed during clean-snapshot copy; retry from a stable checkout");
  snapshotCompleteness = assertSnapshotCompleteness(manifestEntries, sourceInventory);
  const sourceInventoryAfterCopy = collectGitSourceInventory(sourceRoot, fixture);
  if (sourceInventoryAfterCopy.inventorySha256 !== sourceInventory.inventorySha256) throw new Error("Git tracked/untracked source inventory changed during clean-snapshot copy; retry from a stable checkout");
  const manifest = { schemaVersion: 1, source: "git-tracked-baseline-plus-intended-worktree", digestAlgorithm: "sha256", digest: manifestDigest, fileCount: manifestEntries.length, excluded: fixture.snapshot, sourceInventory, completeness: snapshotCompleteness, files: manifestEntries };
  fs.writeFileSync(path.join(reportDir, "clean-snapshot-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  for (const dependency of fixture.snapshot.dependencyLinks) {
    const source = path.join(sourceRoot, dependency); const target = path.join(snapshotRoot, dependency);
    if (!fs.existsSync(source)) throw new Error(`Preinstalled dependency tree is missing: ${dependency}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(fs.realpathSync(source), target, "junction");
  }
  const runtimeRoot = path.join(snapshotRoot, ".ws15-runtime"); const tempDir = path.join(runtimeRoot, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const guardUrl = pathToFileURL(path.join(snapshotRoot, "scripts", "offline-network-guard.mjs")).href;
  const child = spawnSync(command[0], command.slice(1), {
    cwd: snapshotRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      WS15_CLEAN_SNAPSHOT: "1",
      WS15_CLEAN_SNAPSHOT_DIGEST: manifestDigest,
      WS15_OFFLINE_GUARD: "1",
      WS15_NETWORK_AUDIT_FILE: networkAuditFile,
      WS15_REPORT_DIR: reportDir,
      USERS_CONFIG: path.join(runtimeRoot, "users.json"),
      APP_SETTINGS_CONFIG: path.join(runtimeRoot, "app-settings.json"),
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      GIT_TERMINAL_PROMPT: "0",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost,::1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${guardUrl}`.trim(),
    },
  });
  if (child.error) throw child.error;
  exitCode = child.status ?? 1; signal = child.signal;
} catch (error) {
  process.stderr.write(`WS-15 clean-snapshot verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  const audit = fs.readFileSync(networkAuditFile, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { type: "invalid_audit_line" }; } });
  const guardLoads = audit.filter((entry) => entry.type === "guard_loaded").length;
  const expectedSelfTestKinds = ["tcp", "http", "https", "fetch"];
  const blockedSelfTestEntries = audit.filter((entry) => entry.type === "external_egress_blocked" && entry.host === "ws15-external-network.invalid" && expectedSelfTestKinds.includes(entry.kind));
  const blockedSelfTestKinds = [...new Set(blockedSelfTestEntries.map((entry) => entry.kind))].sort();
  const selfTestCoveragePassed = expectedSelfTestKinds.every((kind) => blockedSelfTestKinds.includes(kind));
  const unexpectedExternalAttempts = audit.filter((entry) => entry.type === "external_egress_blocked" && !(entry.host === "ws15-external-network.invalid" && expectedSelfTestKinds.includes(entry.kind)));
  const protectedArtifactsAfter = { history: artifactFingerprint(".history"), checkpoints: artifactFingerprint(".checkpoints") };
  const protectedArtifactsUntouched = JSON.stringify(protectedArtifactsBefore) === JSON.stringify(protectedArtifactsAfter);
  if (guardLoads === 0 || !selfTestCoveragePassed || unexpectedExternalAttempts.length > 0 || !protectedArtifactsUntouched) exitCode = 1;
  const report = {
    schemaVersion: 1,
    kind: "crewforge-ws15-clean-snapshot",
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Number((performance.now() - started).toFixed(3)),
    manifestDigest,
    fileCount: manifestEntries.length,
    command,
    diffCheck,
    sourceInventory: sourceInventory ? { head: sourceInventory.head, inventorySha256: sourceInventory.inventorySha256, trackedFiles: sourceInventory.trackedFiles.length, deletedTrackedFiles: sourceInventory.deletedTrackedFiles, intendedUntrackedFiles: sourceInventory.intendedUntrackedFiles, expectedIncludedFiles: sourceInventory.expectedIncludedFiles.length, trackedPatchSha256: sourceInventory.trackedPatchSha256 } : null,
    snapshotCompleteness,
    dependencyMode: "preinstalled-host-symlinks",
    sourceArtifacts: { before: protectedArtifactsBefore, after: protectedArtifactsAfter, untouched: protectedArtifactsUntouched },
    network: {
      nodeGuardRequired: true,
      npmOffline: true,
      guardLoads,
      evidenceScope: ["Node net.Socket TCP connect", "node:http", "node:https", "global fetch"],
      notCovered: ["DNS", "UDP", "raw sockets", "native binaries", "child processes that do not inherit the Node preload", "other non-Node egress"],
      blockedSelfTests: blockedSelfTestEntries.length,
      blockedSelfTestKinds,
      selfTestCoveragePassed,
      unexpectedExternalAttempts,
    },
    exitCode,
    signal,
    cleanup,
  };
  const tempReport = path.join(reportDir, `clean-snapshot-report.json.tmp-${process.pid}`);
  fs.writeFileSync(tempReport, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempReport, path.join(reportDir, "clean-snapshot-report.json"));

  cleanup.attempted = true;
  const resolvedTemporary = fs.realpathSync(temporaryRoot); const resolvedOsTemp = fs.realpathSync(os.tmpdir());
  if (!resolvedTemporary.startsWith(`${resolvedOsTemp}${path.sep}`) || !path.basename(resolvedTemporary).startsWith("crewforge-ws15-clean-")) {
    process.stderr.write(`Refusing unsafe temporary cleanup target: ${resolvedTemporary}\n`);
  } else {
    fs.rmSync(resolvedTemporary, { recursive: true, force: true }); cleanup.passed = true;
  }
  report.cleanup = cleanup;
  fs.writeFileSync(path.join(reportDir, "clean-snapshot-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

process.exitCode = exitCode;
