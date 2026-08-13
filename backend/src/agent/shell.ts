import { evaluateShellCommand } from "./toolPolicy.js";
import { ProcessResourceLimits, WorkspaceFilesystemGrant, runWorkspaceProcess } from "./processSandbox.js";

export const DEFAULT_COMPATIBILITY_SHELL_LIMITS: Readonly<ProcessResourceLimits> = Object.freeze({
  cpuTimeMs: 60_000,
  memoryBytes: process.platform === "linux" ? 4 * 1024 * 1024 * 1024 : undefined,
  maxOpenFiles: 256,
});

export interface WorkspaceCommandOptions {
  /** Required before the legacy shell parser is allowed to accept shell syntax. */
  compatibilityShellAuthorized?: boolean;
  resourceLimits?: ProcessResourceLimits;
  /** Effective admin/profile/workspace sandbox grant for this agent run. */
  filesystem?: WorkspaceFilesystemGrant;
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
  });
  if (!policy.allowed) return `Error: Command blocked by workspace policy: ${policy.reason}`;
  if (signal?.aborted) return "Error: Stopped before shell execution";

  const limits: ProcessResourceLimits = {
    wallTimeMs: options.resourceLimits?.wallTimeMs,
    cpuTimeMs: options.resourceLimits?.cpuTimeMs ?? DEFAULT_COMPATIBILITY_SHELL_LIMITS.cpuTimeMs,
    memoryBytes: options.resourceLimits?.memoryBytes ?? DEFAULT_COMPATIBILITY_SHELL_LIMITS.memoryBytes,
    maxOpenFiles: options.resourceLimits?.maxOpenFiles ?? DEFAULT_COMPATIBILITY_SHELL_LIMITS.maxOpenFiles,
  };

  if (process.platform === "win32") {
    return runWorkspaceProcess({
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
      cwd,
      signal,
      limits,
      resourceLimitMode: "posix-shell",
      networkMode: "deny",
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
    networkMode: "deny",
    filesystem: options.filesystem || { workspaceDir: cwd, readPaths: ["."], writePaths: ["."] },
  });
}

export { runWorkspaceProcess } from "./processSandbox.js";
