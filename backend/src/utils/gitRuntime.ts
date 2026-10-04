import fs from "node:fs";
import path from "node:path";
import { desktopNativeIdeEnabled } from "../desktop/nativeIdeClient.js";

/** Desktop-owned absolute paths avoid workspace/PATH executable substitution.
 * Web and development callers retain their existing system Git behavior. */
export function gitExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (!desktopNativeIdeEnabled(env)) return "git";
  const executable = env.CROWNFORGE_GIT_EXECUTABLE;
  if (!executable) {
    if (env.CROWNFORGE_BUNDLED_TOOLS_REQUIRED === "1") throw new Error("Bundled Git runtime is missing");
    return "git";
  }
  if (!path.isAbsolute(executable) || executable.includes("\0")) throw new Error("Bundled Git executable must be absolute");
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Bundled Git executable must be a regular file");
  return fs.realpathSync.native(executable);
}

/** Read-only runtime authority comes from the desktop owner, never a tool DTO. */
export function bundledGitReadPaths(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!desktopNativeIdeEnabled(env) || !env.CROWNFORGE_GIT_RUNTIME_ROOT) return [];
  const configured = env.CROWNFORGE_GIT_RUNTIME_ROOT;
  if (!path.isAbsolute(configured)) throw new Error("Bundled Git runtime root must be absolute");
  const root = fs.realpathSync.native(configured);
  const workspace = fs.realpathSync.native(workspaceDir);
  const executable = gitExecutable(env);
  const inside = (candidate: string, parent: string) => {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (!inside(executable, root) || inside(root, workspace) || inside(workspace, root)) throw new Error("Bundled Git runtime must stay outside the workspace");
  if (!fs.statSync(root).isDirectory()) throw new Error("Bundled Git runtime root must be a directory");
  return [root];
}
