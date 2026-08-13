import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const strictArgs = ["--noEmit", "--noUnusedLocals", "--noUnusedParameters"];

function defaultTscCommand(root, project) {
  const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
  return path.join(root, project, "node_modules", ".bin", executable);
}

export function runStrictStaticQuality({ root, tscCommand, env = process.env }) {
  const checks = [];
  for (const project of ["backend", "frontend"]) {
    const started = performance.now();
    const executable = typeof tscCommand === "function" ? tscCommand(project) : tscCommand || defaultTscCommand(root, project);
    const result = spawnSync(executable, strictArgs, {
      cwd: path.join(root, project),
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    const status = result.status ?? 1;
    checks.push({
      project,
      command: ["tsc", ...strictArgs],
      executable,
      status,
      signal: result.signal,
      error: result.error?.message || null,
      stdout: String(result.stdout || "").slice(-200_000),
      stderr: String(result.stderr || "").slice(-200_000),
      durationMs: Number((performance.now() - started).toFixed(3)),
      passed: !result.error && status === 0,
    });
  }
  return {
    schemaVersion: 1,
    kind: "crewforge-strict-static-quality",
    checks,
    gate: {
      passed: checks.length === 2 && checks.every((check) => check.passed),
      expectedChecks: 2,
      executedChecks: checks.length,
      skipped: 0,
    },
  };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const report = runStrictStaticQuality({ root });
  for (const check of report.checks) {
    if (check.stdout) process.stdout.write(check.stdout.endsWith("\n") ? check.stdout : `${check.stdout}\n`);
    if (check.stderr) process.stderr.write(check.stderr.endsWith("\n") ? check.stderr : `${check.stderr}\n`);
    if (check.error) process.stderr.write(`${check.project} strict tsc failed to start: ${check.error}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.gate.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
