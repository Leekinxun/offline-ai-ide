import { tokenizeInspectionCommand } from "./modeCapabilities.js";
import { evaluateContextPath } from "./contextPolicy.js";

/** Recognize local checks, not arbitrary shells, installers, or fix commands.
 * These still execute project code and require workspace-scoped approval. */
export function isLocalVerificationCommand(command: string): boolean {
  if (command.length > 4000) return false;
  const scoped = /^cd\s+(.+?)\s+&&\s+(.+)$/.exec(command.trim());
  if (scoped) {
    if (/[;&|<>`$(){}*?\[\]\\\n\r\0]/.test(scoped[1])) return false;
    const directory = tokenizeInspectionCommand(`cd ${scoped[1]}`);
    const target = directory[1];
    return directory.length === 2 && Boolean(target) && !target.startsWith("-")
      && (target === "." || evaluateContextPath(target).allowed)
      && isLocalVerificationCommand(scoped[2]);
  }
  if (!command.trim() || command.length > 4000 || /[;&|<>`$(){}*?\[\]\\\n\r\0]/.test(command)) return false;
  const tokens = tokenizeInspectionCommand(command);
  if (!tokens.length) return false;
  // Keep targets inside the ordinary workspace; options with path values must
  // obey the same boundary. The process sandbox enforces the effective grants.
  if (tokens.some((token) => {
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    return value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)
      || value.split("/").includes("..")
      || (!value.startsWith("-") && value !== "." && ["protected", "secret", "invalid_path"].includes(evaluateContextPath(value).reason || ""));
  })) return false;
  const [name, ...args] = tokens;
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
    const script = args[0] === "run" ? args[1] : args[0];
    return /^(?:test(?::[\w-]+)?|lint(?::[\w-]+)?|typecheck|check|build)$/.test(script || "")
      && !args.some((arg) => /^(?:--fix|--watch|--updateSnapshot|-u)(?:=|$)/.test(arg));
  }
  let checkArgs = args;
  if (name === "python" || name === "python3") {
    let index = 0;
    while (["-B", "-I", "-s", "-E"].includes(args[index])) index += 1;
    if (args[index] !== "-m") return false;
    const module = args[index + 1];
    checkArgs = args.slice(index + 2);
    if (module === "unittest") return true;
    if (module === "pytest") return !checkArgs.some((arg) => /^(?:--basetemp|--override-ini|-o)(?:=|$)/.test(arg));
    if (module !== "ruff") return false;
  } else if (name === "pytest") {
    return !checkArgs.some((arg) => /^(?:--basetemp|--override-ini|-o)(?:=|$)/.test(arg));
  } else if (name !== "ruff") return false;
  return checkArgs[0] === "check"
    && !checkArgs.some((arg) => /^(?:--fix|--fix-only|--unsafe-fixes|--add-noqa|--watch|--output-file)(?:=|$)/.test(arg));
}
