import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";

import {
  assertSnapshotCompleteness,
  collectGitSourceInventory,
  discoverBackendTests,
  evaluateFrontendBundleBudget,
} from "./release-methodology.mjs";
import { runStrictStaticQuality } from "./strict-static-quality.mjs";

const inventoryFixture = { snapshot: { excludedRootEntries: [".git"], excludedRelativePaths: [], excludedDirectoryNames: ["node_modules"], excludedFileNames: [], excludedSuffixes: [] } };

test("backend test discovery recursively includes root and nested test files", (t) => {
  const backend = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-release-tests-"));
  t.after(() => fs.rmSync(backend, { recursive: true, force: true }));
  for (const relative of ["src/config.test.ts", "src/agent/root.test.ts", "src/collaboration/deep/store.test.ts", "src/ws/terminal.test.ts", "src/utils/not-a-test.ts"]) {
    const target = path.join(backend, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "export {};\n");
  }
  assert.deepEqual(discoverBackendTests(backend), ["src/agent/root.test.ts", "src/collaboration/deep/store.test.ts", "src/config.test.ts", "src/ws/terminal.test.ts"]);
});

test("snapshot completeness rejects omitted and inventory-unknown files", () => {
  const inventory = { expectedIncludedFiles: ["README.md", "backend/src/index.ts"] };
  assert.doesNotThrow(() => assertSnapshotCompleteness([{ path: "README.md" }, { path: "backend/src/index.ts" }], inventory));
  assert.throws(() => assertSnapshotCompleteness([{ path: "README.md" }], inventory), /omitted.*backend\/src\/index\.ts/i);
  assert.throws(() => assertSnapshotCompleteness([{ path: "README.md" }, { path: "backend/src/index.ts" }, { path: "ignored-secret.ts" }], inventory), /not present in Git tracked \+ intended untracked inventory.*ignored-secret\.ts/i);
});

test("Git source inventory distinguishes tracked, deleted, intended untracked, and ignored files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-release-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored-*.ts\n");
  fs.writeFileSync(path.join(root, "tracked.ts"), "export const tracked = true;\n");
  fs.writeFileSync(path.join(root, "deleted.ts"), "export const deleted = true;\n");
  git("add", ".gitignore", "tracked.ts", "deleted.ts");
  git("-c", "user.email=release@example.invalid", "-c", "user.name=Release Test", "commit", "-m", "baseline");
  fs.rmSync(path.join(root, "deleted.ts"));
  fs.writeFileSync(path.join(root, "intended.ts"), "export const intended = true;\n");
  fs.writeFileSync(path.join(root, "ignored-secret.ts"), "export const ignored = true;\n");
  const inventory = collectGitSourceInventory(root, inventoryFixture);
  assert.deepEqual(inventory.deletedTrackedFiles, ["deleted.ts"]);
  assert.ok(inventory.intendedUntrackedFiles.includes("intended.ts"));
  assert.ok(!inventory.intendedUntrackedFiles.includes("ignored-secret.ts"));
  assert.doesNotThrow(() => assertSnapshotCompleteness(inventory.expectedIncludedFiles.map((entry) => ({ path: entry })), inventory));
  assert.throws(() => assertSnapshotCompleteness([...inventory.expectedIncludedFiles.map((entry) => ({ path: entry })), { path: "ignored-secret.ts" }], inventory), /not present in Git tracked \+ intended untracked inventory/i);
});

test("frontend bundle budget constrains the HTML main shell and permits only explicit Monaco exceptions", (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-bundle-budget-"));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const assets = path.join(dist, "assets"); fs.mkdirSync(assets);
  fs.writeFileSync(path.join(dist, "index.html"), '<script type="module" crossorigin src="/assets/index-main.js"></script>');
  fs.writeFileSync(path.join(assets, "index-main.js"), Buffer.alloc(600));
  fs.writeFileSync(path.join(assets, "feature.js"), Buffer.alloc(400));
  fs.writeFileSync(path.join(assets, "ts.worker-hash.js"), Buffer.alloc(5_000));
  fs.writeFileSync(path.join(assets, "monaco-core-hash.js"), Buffer.alloc(5_000));
  const budget = {
    mainShellMaxBytes: 700,
    otherJavaScriptMaxBytes: 500,
    exceptions: [
      { pattern: "^assets/(?:editor|json|html|css|ts)\\.worker-[^.]+\\.js$", reason: "Monaco workers" },
      { pattern: "^assets/monaco-core-[^.]+\\.js$", reason: "Monaco core" },
    ],
  };
  assert.equal(evaluateFrontendBundleBudget(dist, budget).passed, true);
  fs.writeFileSync(path.join(assets, "index-main.js"), Buffer.alloc(701));
  assert.match(evaluateFrontendBundleBudget(dist, budget).failures.join("\n"), /main shell/i);
  fs.writeFileSync(path.join(assets, "index-main.js"), Buffer.alloc(600));
  fs.writeFileSync(path.join(assets, "unexpected.js"), Buffer.alloc(501));
  assert.match(evaluateFrontendBundleBudget(dist, budget).failures.join("\n"), /unexpected\.js/);
});

test("strict static quality executes backend and frontend tsc and propagates either failure", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-strict-static-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const project of ["backend", "frontend"]) fs.mkdirSync(path.join(root, project));
  const log = path.join(root, "tsc-invocations.ndjson");
  const fakeTsc = path.join(root, "tsc");
  fs.writeFileSync(fakeTsc, `#!/bin/sh\nprintf '{"cwd":"%s","args":"%s"}\\n' "$PWD" "$*" >> "$STRICT_STATIC_LOG"\nif [ -f "$PWD/.fail-strict" ]; then exit 7; fi\n`, { mode: 0o755 });
  const expectedArgs = ["--noEmit", "--noUnusedLocals", "--noUnusedParameters"];
  const passed = runStrictStaticQuality({ root, tscCommand: fakeTsc, env: { ...process.env, STRICT_STATIC_LOG: log } });
  assert.equal(passed.gate.passed, true);
  assert.deepEqual(passed.checks.map((entry) => entry.command), [["tsc", ...expectedArgs], ["tsc", ...expectedArgs]]);
  const invocations = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(invocations.map((entry) => path.basename(entry.cwd)), ["backend", "frontend"]);
  assert.deepEqual(invocations.map((entry) => entry.args), [expectedArgs.join(" "), expectedArgs.join(" ")]);
  fs.writeFileSync(path.join(root, "frontend", ".fail-strict"), "fail\n");
  const failed = runStrictStaticQuality({ root, tscCommand: fakeTsc, env: { ...process.env, STRICT_STATIC_LOG: log } });
  assert.equal(failed.gate.passed, false);
  assert.deepEqual(failed.checks.map((entry) => ({ project: entry.project, status: entry.status, passed: entry.passed })), [
    { project: "backend", status: 0, passed: true },
    { project: "frontend", status: 7, passed: false },
  ]);

  const scriptDirectory = path.join(root, "scripts");
  fs.mkdirSync(scriptDirectory);
  const strictScript = path.join(scriptDirectory, "strict-static-quality.mjs");
  fs.copyFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "strict-static-quality.mjs"), strictScript);
  for (const project of ["backend", "frontend"]) {
    const bin = path.join(root, project, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(fakeTsc, path.join(bin, "tsc"));
    fs.chmodSync(path.join(bin, "tsc"), 0o755);
  }
  fs.rmSync(path.join(root, "frontend", ".fail-strict"));
  const cliPassed = spawnSync(process.execPath, [strictScript], { encoding: "utf8", env: { ...process.env, STRICT_STATIC_LOG: log } });
  assert.equal(cliPassed.status, 0);
  assert.equal(JSON.parse(cliPassed.stdout.trim().split("\n").at(-1)).gate.passed, true);
  fs.writeFileSync(path.join(root, "backend", ".fail-strict"), "fail\n");
  const cliFailed = spawnSync(process.execPath, [strictScript], { encoding: "utf8", env: { ...process.env, STRICT_STATIC_LOG: log } });
  assert.equal(cliFailed.status, 1);
  assert.equal(JSON.parse(cliFailed.stdout.trim().split("\n").at(-1)).gate.passed, false);
});

test("release methodology is a mandatory zero-skip release gate", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const verifier = fs.readFileSync(path.join(root, "scripts", "verify-release.mjs"), "utf8");
  const fixture = JSON.parse(fs.readFileSync(path.join(root, "scripts", "fixtures", "ws15-release-contract.json"), "utf8"));
  assert.match(verifier, /mandatoryNames\s*=\s*\[[^\]]*"release-methodology"/s);
  assert.match(verifier, /name:\s*"release-methodology"[\s\S]*?mandatory:\s*true[\s\S]*?release-methodology\.test\.mjs[\s\S]*?noSkips:\s*true/);
  assert.match(verifier, /mandatoryNames\s*=\s*\[[^\]]*"strict-static-quality"/s);
  assert.match(verifier, /name:\s*"strict-static-quality"[\s\S]*?mandatory:\s*true[\s\S]*?strict-static-quality\.mjs[\s\S]*?machineReportName:\s*"strict-static-quality-report\.json"/);
  assert.ok(fixture.requiredReleaseTokens.includes("release-methodology"));
  assert.ok(fixture.requiredReleaseTokens.includes("release-methodology.test.mjs"));
  assert.ok(fixture.mandatorySecurityTests.includes("src/security/g002Adversarial.test.ts"));
  const securityFile = "src/chat/changeSetReleaseSecurity.test.ts";
  const securityMarker = "schema-v3 integrity binds every capture and transition semantic independent of JSON key order";
  const recoveryFile = "src/chat/changeSetReleaseRecovery.test.ts";
  const recoveryMarker = "live after-write-ahead recovery callers conflict without rolling back an active integration";
  const staleIntegrationMarker = "stale ChangeSet integration locks fail closed across child processes without parent mutation";
  const staleTransitionMarker = "stale ChangeSet transition locks reject competing child decisions without last-writer-wins";
  const uncertainLockMarker = "stale reused-pid, EPERM, and malformed ChangeSet locks require explicit recovery";
  const routeFile = "src/chat/checkpointRoutes.test.ts";
  const routeMarker = "recover route reports the actual pre-CAS, post-CAS, idle, and unresolved outcomes";
  assert.ok(fixture.mandatorySecurityTests.includes(securityFile));
  assert.ok(fixture.mandatoryRecoveryTests.includes(recoveryFile));
  assert.deepEqual(fixture.mandatoryTestMarkers?.security, [{ file: securityFile, testName: securityMarker }]);
  assert.deepEqual(fixture.mandatoryTestMarkers?.recovery, [
    { file: recoveryFile, testName: recoveryMarker },
    { file: recoveryFile, testName: staleIntegrationMarker },
    { file: recoveryFile, testName: staleTransitionMarker },
    { file: recoveryFile, testName: uncertainLockMarker },
    { file: routeFile, testName: routeMarker },
  ]);
  assert.match(fs.readFileSync(path.join(root, "backend", securityFile), "utf8"), new RegExp(securityMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(fs.readFileSync(path.join(root, "backend", recoveryFile), "utf8"), new RegExp(recoveryMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(fixture.mandatoryRecoveryTests.includes(routeFile));
  for (const [file, marker] of [[recoveryFile, staleIntegrationMarker], [recoveryFile, staleTransitionMarker], [recoveryFile, uncertainLockMarker], [routeFile, routeMarker]]) {
    assert.match(fs.readFileSync(path.join(root, "backend", file), "utf8"), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.ok(fixture.requiredReleaseTokens.includes("mandatoryTestMarkers"));
  const g002 = fs.readFileSync(path.join(root, "backend", "src", "security", "g002Adversarial.test.ts"), "utf8");
  assert.match(g002, /ChangeSet integrity binds dirty semantics so merge and cherry-pick cannot drop untracked bytes/);
});

test("mandatory browserless gate covers every root TypeScript policy and recovery test", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const verifier = fs.readFileSync(path.join(root, "scripts", "verify-release.mjs"), "utf8");
  const browserlessGate = verifier.split("\n").find((line) => line.includes('name: "browserless-e2e-contracts"')) || "";
  assert.match(browserlessGate, /mandatory:\s*true/);
  assert.match(browserlessGate, /noSkips:\s*true/);
  const rootPolicyTests = fs.readdirSync(path.join(root, "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name)
    .sort();
  assert.ok(rootPolicyTests.length > 0);
  for (const filename of rootPolicyTests) assert.ok(browserlessGate.includes(`../scripts/${filename}`), `${filename} is missing from the mandatory browserless release gate`);
  assert.ok(!browserlessGate.includes("release-methodology.test.mjs"), "release methodology must remain an independent mandatory gate");
});
