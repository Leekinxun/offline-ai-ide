import fs from "node:fs";
import path from "node:path";
import { evaluateInspectionCommand, tokenizeInspectionCommand } from "./modeCapabilities.js";
import { linuxTrustedRuntimeReadPaths } from "./processSandbox.js";

export interface ReadOnlyShellPlan {
  kind: "listing" | "version";
  command: string;
  executableName: string;
  args: string[];
}

/** A deliberately small syntax-only allowlist, shared by approval and execution. */
export function planReadOnlyShell(command: unknown): ReadOnlyShellPlan | null {
  if (typeof command !== "string" || !command.trim() || command.length > 4000 || /[;&|<>`$(){}*?\[\]\n\r\0]/.test(command)) return null;
  const tokens = tokenizeInspectionCommand(command.trim());
  const [name, ...args] = tokens;
  if ((name === "pwd" || name === "ls") && evaluateInspectionCommand(command).allowed) {
    return { kind: "listing", command: command.trim(), executableName: name, args };
  }
  if (["python", "python3", "node", "git", "ruff"].includes(name)
    && args.length === 1 && args[0] === "--version") {
    return { kind: "version", command: command.trim(), executableName: name, args: name.startsWith("python") ? ["-I", "-B", "--version"] : args };
  }
  if ((name === "python" || name === "python3") && ["-m ruff --version", "-I -B -m ruff --version"].includes(args.join(" "))) {
    // -I ignores cwd, PYTHONPATH and user site packages; -B avoids pycache writes.
    return { kind: "version", command: command.trim(), executableName: name, args: ["-I", "-B", "-m", "ruff", "--version"] };
  }
  return null;
}

function inside(candidate: string, root: string): boolean { return candidate === root || candidate.startsWith(root + path.sep); }

function trustedOwnership(executable: string): boolean {
  const allowedOwners = process.platform === "darwin" ? [0, process.getuid?.()] : [0];
  for (let current = executable; ; current = path.dirname(current)) {
    const stat = fs.statSync(current);
    if (!allowedOwners.includes(stat.uid) || (stat.mode & 0o022) !== 0) return false;
    if (current === path.dirname(current)) return true;
  }
}

/** Never auto-run an executable supplied by the workspace or a relative PATH entry. */
export function resolveReadOnlyExecutable(plan: ReadOnlyShellPlan, workspaceDir: string, searchPath = process.env.PATH || ""): string | null {
  if (process.platform === "win32") return null;
  const workspace = fs.realpathSync.native(workspaceDir);
  const runtimeRoots = process.platform === "linux"
    ? ["/usr", "/bin", "/sbin", ...linuxTrustedRuntimeReadPaths()]
    : ["/usr", "/bin", "/sbin", "/System", "/Library"];
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, plan.executableName);
    try {
      const executable = fs.realpathSync.native(candidate);
      if (!runtimeRoots.some((root) => inside(executable, root)) || inside(executable, workspace)) return null;
      const stat = fs.statSync(executable);
      if (!stat.isFile() || (stat.mode & 0o111) === 0 || !trustedOwnership(executable)) return null;
      return executable;
    } catch { /* Try the next absolute search directory. */ }
  }
  return null;
}
