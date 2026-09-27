import { evaluateShellCommand } from "./toolPolicy.js";
import { ProcessResourceLimits, WorkspaceFilesystemGrant, runWorkspaceProcess } from "./processSandbox.js";
import { evaluateInspectionCommand, tokenizeInspectionCommand } from "./modeCapabilities.js";
import fs from "node:fs";
import path from "node:path";
import { safePath } from "../utils/safePath.js";
import { readAuthorizedWorkspaceFile } from "./contextPolicy.js";

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

/** Read-only commands share the policy parser and never enter a shell. */
export async function runInspectionCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  filesystem?: WorkspaceFilesystemGrant
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
  return runWorkspaceProcess({
    executable,
    args,
    cwd,
    signal,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    limits: { wallTimeMs: 60_000, ...DEFAULT_COMPATIBILITY_SHELL_LIMITS },
    resourceLimitMode: "posix-shell",
    networkMode: "deny",
    filesystem: { workspaceDir: cwd, readPaths: filesystem?.readPaths || ["."], writePaths: [] },
  });
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
