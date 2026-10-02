import fs from "node:fs";
import path from "node:path";

/** Identity-based authority for fixed server-owned Node payloads, never JSON input. */
export const INTERNAL_NODE_RUNTIME = Object.freeze({ kind: "internal-node-runtime" as const });

/** The current bundle's Frameworks directory only; redirected roots fail closed. */
export function macosNodeRuntimeFrameworks(): string | undefined {
  if (process.platform !== "darwin" || !process.versions.electron) return undefined;
  try {
    const executable = fs.realpathSync.native(process.execPath);
    const macOS = path.dirname(executable); const contents = path.dirname(macOS);
    if (path.basename(macOS) !== "MacOS" || path.basename(contents) !== "Contents" || !path.basename(path.dirname(contents)).endsWith(".app")) return undefined;
    const frameworks = path.join(contents, "Frameworks");
    const stat = fs.lstatSync(frameworks);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return fs.realpathSync.native(frameworks) === frameworks ? frameworks : undefined;
  } catch { return undefined; }
}

/** Only for fixed internal launches of process.execPath, after environment sanitization. */
export function nodeRuntimeEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  const result = { ...environment };
  // The desktop backend runs inside Electron's Node runtime. Its executable
  // starts the GUI unless this flag is explicitly restored for Node children.
  if (process.versions.electron) result.ELECTRON_RUN_AS_NODE = "1";
  else delete result.ELECTRON_RUN_AS_NODE;
  return result;
}
