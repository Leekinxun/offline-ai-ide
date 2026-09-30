import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  linuxTrustedRuntimeReadPaths, probeFilesystemIsolation, probeNetworkIsolation,
  runWorkspaceProcess, sanitizeIsolationDiagnostic, type NetworkIsolationCapability,
} from "../agent/processSandbox.js";

export interface SandboxDiagnostics {
  checkedAt: number;
  platform: NodeJS.Platform;
  kernel: string;
  uid: number | null;
  gid: number | null;
  helperVersion: string | null;
  filesystem: NetworkIsolationCapability;
  network: NetworkIsolationCapability;
  executionReady: boolean;
  runtimeReadPaths: string[];
  linux: {
    noNewPrivs: number | null;
    effectiveCapabilities: string | null;
    seccomp: number | null;
    apparmorProfile: string | null;
    maxUserNamespaces: number | null;
    unprivilegedUsernsClone: number | null;
    apparmorRestrictUnprivilegedUserns: number | null;
  } | null;
}

/** A fixed, bounded allowlist of kernel metadata; never environment or application configuration. */
function readKernelValue(file: string): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(4_096);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    return sanitizeIsolationDiagnostic(bytes.subarray(0, length));
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function integer(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export function parseSandboxProcessStatus(value: string): Pick<NonNullable<SandboxDiagnostics["linux"]>, "noNewPrivs" | "effectiveCapabilities" | "seccomp"> {
  const field = (name: string) => value.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? null;
  const capabilities = field("CapEff");
  return { noNewPrivs: integer(field("NoNewPrivs")), effectiveCapabilities: capabilities && /^[a-f0-9]{1,16}$/i.test(capabilities) ? capabilities : null, seccomp: integer(field("Seccomp")) };
}

export function collectSandboxDiagnostics(): SandboxDiagnostics {
  const filesystem = probeFilesystemIsolation();
  const network = probeNetworkIsolation();
  let helperVersion: string | null = null;
  const executable = filesystem.executable || network.executable;
  if (process.platform === "linux" && executable) {
    const version = childProcess.spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 1_000, maxBuffer: 4_096, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    if (version.status === 0) helperVersion = sanitizeIsolationDiagnostic(version.stdout).slice(0, 160) || null;
  }
  return {
    checkedAt: Date.now(), platform: process.platform, kernel: os.release(),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    helperVersion, filesystem, network, executionReady: filesystem.available && network.available,
    runtimeReadPaths: process.platform === "linux" ? linuxTrustedRuntimeReadPaths() : [],
    linux: process.platform === "linux" ? {
      ...parseSandboxProcessStatus(readKernelValue("/proc/self/status") || ""),
      apparmorProfile: readKernelValue("/proc/self/attr/current"),
      maxUserNamespaces: integer(readKernelValue("/proc/sys/user/max_user_namespaces")),
      unprivilegedUsernsClone: integer(readKernelValue("/proc/sys/kernel/unprivileged_userns_clone")),
      apparmorRestrictUnprivilegedUserns: integer(readKernelValue("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")),
    } : null,
  };
}

export function createSandboxDiagnosticsReader(read = collectSandboxDiagnostics, now = Date.now): () => SandboxDiagnostics {
  let cached: SandboxDiagnostics | undefined;
  let expiresAt = 0;
  return () => {
    if (!cached || now() >= expiresAt) { cached = read(); expiresAt = now() + 30_000; }
    return structuredClone(cached);
  };
}

export const getSandboxDiagnostics = createSandboxDiagnosticsReader();

export interface SandboxSelfTestResult {
  passed: boolean;
  diagnostics: SandboxDiagnostics;
  checks?: Record<string, boolean>;
  error?: string;
}

/** Operator/CI-only test: all write probes use disposable canaries, never the active workspace. */
export async function runSandboxSelfTest(): Promise<SandboxSelfTestResult> {
  const diagnostics = collectSandboxDiagnostics();
  if (!diagnostics.executionReady) return { passed: false, diagnostics, error: "Required OS isolation is unavailable; no command was run outside the sandbox" };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-isolation-test-"));
  const workspace = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside.txt");
  const server = net.createServer((socket) => socket.end());
  try {
    fs.mkdirSync(path.join(workspace, "allowed"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".codex"));
    fs.writeFileSync(path.join(workspace, "allowed/input.txt"), "allowed-canary");
    fs.writeFileSync(path.join(workspace, ".env"), "private-canary");
    fs.writeFileSync(path.join(workspace, ".codex/control.txt"), "control-canary");
    fs.writeFileSync(outside, "outside-canary");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not create isolated test listener");
    const command = `
      const fs = require('fs'); const net = require('net'); const cp = require('child_process');
      const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
      const write = file => { try { fs.writeFileSync(file, 'unexpected'); return true; } catch { return false; } };
      const evidence = { allowedRead: read('allowed/input.txt'), allowedWrite: write('allowed/output.txt'),
        secretRead: read('.env'), controlWrite: write('.codex/control.txt'), outsideWrite: write(process.argv[1]),
        nullWrite: write('/dev/null') };
      if (process.argv[3] === 'conda') {
        try { evidence.python = cp.execFileSync('/opt/conda/bin/python', ['--version'], { encoding: 'utf8' }).trim(); } catch { evidence.python = ''; }
        try { evidence.ruff = cp.execFileSync('/opt/conda/bin/ruff', ['--version'], { encoding: 'utf8' }).trim(); } catch { evidence.ruff = ''; }
      }
      const socket = net.connect({ host: '127.0.0.1', port: Number(process.argv[2]) });
      let finished = false; const done = reachable => { if (finished) return; finished = true; socket.destroy(); process.stdout.write(JSON.stringify({ ...evidence, parentReachable: reachable })); };
      socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(false));
    `;
    const conda = diagnostics.runtimeReadPaths.includes("/opt/conda");
    const output = await runWorkspaceProcess({ executable: process.execPath, args: ["-e", command, outside, String(address.port), conda ? "conda" : ""], cwd: workspace,
      filesystem: { workspaceDir: workspace, readPaths: ["."], writePaths: ["allowed"] }, networkMode: "deny", timeoutMs: 10_000, maxOutputBytes: 8_192 });
    if (output.startsWith("Error:")) return { passed: false, diagnostics, error: sanitizeIsolationDiagnostic(output) };
    const evidence = JSON.parse(output) as Record<string, unknown>;
    const checks = {
      allowedRead: evidence.allowedRead === "allowed-canary", allowedWrite: evidence.allowedWrite === true,
      outsideWriteDenied: evidence.outsideWrite === false && fs.readFileSync(outside, "utf8") === "outside-canary",
      secretReadDenied: evidence.secretRead !== "private-canary",
      controlWriteDenied: evidence.controlWrite === false && fs.readFileSync(path.join(workspace, ".codex/control.txt"), "utf8") === "control-canary",
      nullDeviceWritable: evidence.nullWrite === true, parentNetworkDenied: evidence.parentReachable === false,
      ...(conda ? { condaPythonVisible: /^Python \d/.test(String(evidence.python)), condaRuffVisible: /^ruff \d/.test(String(evidence.ruff)) } : {}),
    };
    return { passed: Object.values(checks).every(Boolean), diagnostics, checks };
  } catch (error) { return { passed: false, diagnostics, error: sanitizeIsolationDiagnostic(error instanceof Error ? error.message : String(error)) }; }
  finally {
    await new Promise<void>((resolve) => { if (server.listening) server.close(() => resolve()); else resolve(); });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
