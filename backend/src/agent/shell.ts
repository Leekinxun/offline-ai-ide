import { evaluateShellCommand } from "./toolPolicy.js";
import { ProcessResourceLimits, WorkspaceFilesystemGrant, runWorkspaceProcess } from "./processSandbox.js";
import { evaluateInspectionCommand, tokenizeInspectionCommand } from "./modeCapabilities.js";
import fs from "node:fs";
import path from "node:path";
import { safePath } from "../utils/safePath.js";
import { readAuthorizedWorkspaceFile } from "./contextPolicy.js";
import { consumeNetworkExecutionGrant, type NetworkExecutionGrant } from "./networkAccess.js";
import { planReadOnlyShell, resolveReadOnlyExecutable } from "./readOnlyShell.js";
import { agentShellInvocation, usesNativeWindowsAgent, windowsInspectionInvocation } from "./windowsShell.js";

export const DEFAULT_COMPATIBILITY_SHELL_LIMITS: Readonly<ProcessResourceLimits> = Object.freeze({
  cpuTimeMs: 60_000,
  memoryBytes: process.platform === "linux" || process.platform === "win32" ? 4 * 1024 * 1024 * 1024 : undefined,
  maxOpenFiles: 256,
});

/** Native Codex exposes wall-time supervision, rather than POSIX rlimits. */
export function defaultAgentShellLimits(): Readonly<ProcessResourceLimits> {
  return usesNativeWindowsAgent() ? {} : DEFAULT_COMPATIBILITY_SHELL_LIMITS;
}

export interface WorkspaceCommandOptions {
  /** Required before the legacy shell parser is allowed to accept shell syntax. */
  compatibilityShellAuthorized?: boolean;
  resourceLimits?: ProcessResourceLimits;
  /** Effective admin/profile/workspace sandbox grant for this agent run. */
  filesystem?: WorkspaceFilesystemGrant;
  networkExecutionGrant?: NetworkExecutionGrant;
}

/** Read-only commands share the policy parser and never enter a shell. */
export async function runInspectionCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  filesystem?: WorkspaceFilesystemGrant,
  trustedExecutable?: string
): Promise<string> {
  const policy = evaluateInspectionCommand(command, (candidate) => {
    try {
      const full = safePath(candidate, cwd);
      let cursor = path.resolve(cwd);
      for (const segment of path.relative(cursor, full).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
          return { allowed: false, reason: "Inspection commands cannot traverse symbolic links" };
        }
      }
      if (fs.existsSync(full) && fs.statSync(full).isFile()) readAuthorizedWorkspaceFile(cwd, candidate);
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  if (!policy.allowed) return `Error: Command blocked by workspace policy: ${policy.reason}`;
  const [executable, ...args] = tokenizeInspectionCommand(command);
  if (executable === "git" && ["diff", "show", "log"].includes(args[0])) {
    args.splice(1, 0, "--no-ext-diff", "--no-textconv");
  }
  const invocation = usesNativeWindowsAgent() ? windowsInspectionInvocation(executable, args, cwd) : { executable: trustedExecutable || executable, args };
  return runWorkspaceProcess({
    ...invocation,
    cwd,
    signal,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: usesNativeWindowsAgent() ? "" : "cat" },
    limits: { wallTimeMs: 60_000, ...defaultAgentShellLimits() },
    resourceLimitMode: "posix-shell",
    networkMode: "deny",
    filesystem: { workspaceDir: cwd, readPaths: filesystem?.readPaths || ["."], writePaths: [] },
  });
}

/** Auto-approved queries always run as argv with read-only workspace mounts. */
export async function runReadOnlyShellCommand(command: string, cwd: string, signal?: AbortSignal, filesystem?: WorkspaceFilesystemGrant): Promise<string> {
  const plan = planReadOnlyShell(command);
  if (!plan) return "Error: Command is not a supported read-only query";
  // The WSL helper resolves these names against root-owned Linux system tools.
  const executable = process.platform === "win32" ? plan.executableName : resolveReadOnlyExecutable(plan, cwd);
  if (!executable) return `Error: A trusted system executable is unavailable for the read-only query: ${plan.executableName}`;
  const grants = { workspaceDir: cwd, readPaths: filesystem?.readPaths || ["."], writePaths: [] };
  if (plan.kind === "inspection") return runInspectionCommand(command, cwd, signal, grants, executable);
  const invocation = usesNativeWindowsAgent() ? windowsInspectionInvocation(plan.executableName, plan.args, cwd) : { executable, args: plan.args };
  return runWorkspaceProcess({ ...invocation, cwd, signal,
    limits: { wallTimeMs: 30_000, ...defaultAgentShellLimits() }, resourceLimitMode: "posix-shell",
    networkMode: "deny", filesystem: grants });
}

/**
 * Legacy shell-string compatibility wrapper. New execution paths must use
 * runWorkspaceProcess(executable, args) so untrusted text is never parsed by a shell.
 */
export async function runWorkspaceCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  options: WorkspaceCommandOptions = {}
): Promise<string> {
  const policy = evaluateShellCommand(command, {
    compatibilityShellAuthorized: options.compatibilityShellAuthorized === true,
    networkAccessAuthorized: Boolean(options.networkExecutionGrant),
    workspaceDir: cwd,
  });
  if (!policy.allowed) return `Error: Command blocked by workspace policy: ${policy.reason}`;
  if (signal?.aborted) return "Error: Stopped before shell execution";
  if (options.networkExecutionGrant) {
    try { consumeNetworkExecutionGrant(options.networkExecutionGrant, cwd, command, "bash"); }
    catch (error) { return `Error: ${error instanceof Error ? error.message : "Invalid network approval"}`; }
  }
  const networkMode = options.networkExecutionGrant ? "inherit" : "deny";

  const limits: ProcessResourceLimits = {
    wallTimeMs: options.resourceLimits?.wallTimeMs,
    cpuTimeMs: options.resourceLimits?.cpuTimeMs ?? defaultAgentShellLimits().cpuTimeMs,
    memoryBytes: options.resourceLimits?.memoryBytes ?? defaultAgentShellLimits().memoryBytes,
    maxOpenFiles: options.resourceLimits?.maxOpenFiles ?? defaultAgentShellLimits().maxOpenFiles,
  };

  if (process.platform === "win32") {
    return runWorkspaceProcess({
      ...agentShellInvocation(command),
      cwd,
      signal,
      limits,
      resourceLimitMode: "posix-shell",
      networkMode,
      filesystem: options.filesystem || { workspaceDir: cwd, readPaths: ["."], writePaths: ["."] },
    });
  }
  return runWorkspaceProcess({
    executable: "/bin/sh",
    // The command is a positional argument to the resource wrapper; it is never
    // interpolated into the trusted wrapper source.
    args: ["-c", command],
    cwd,
    signal,
    limits,
    resourceLimitMode: "posix-shell",
    networkMode,
    filesystem: options.filesystem || { workspaceDir: cwd, readPaths: ["."], writePaths: ["."] },
  });
}

export { runWorkspaceProcess } from "./processSandbox.js";
