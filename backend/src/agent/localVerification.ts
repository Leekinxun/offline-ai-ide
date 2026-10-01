import { tokenizeInspectionCommand } from "./modeCapabilities.js";
import { evaluateContextPath } from "./contextPolicy.js";

export interface LocalVerificationCommandPlan {
  cwd?: string;
  commands: string[];
}

function hasFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function hasJoinedFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(name)));
}

const PACKAGE_MUTATING_OR_WATCH_FLAGS = [
  "--fix", "--fix-only", "--unsafe-fixes", "--add-noqa", "--output-file", "--config",
  "--updateSnapshot", "--update-snapshot", "--update-snapshots", "--update", "-u", "--u",
  "--watch", "--watchAll", "--watch-all",
];
const RUFF_MUTATING_OR_OUTPUT_FLAGS = ["--fix", "--fix-only", "--unsafe-fixes", "--add-noqa", "--watch", "--output-file", "--config"];

function pathTokenAllowed(token: string): boolean {
  const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
  return !(value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)
    || value.split("/").includes("..")
    || (!value.startsWith("-") && value !== "." && ["protected", "secret", "invalid_path"].includes(evaluateContextPath(value).reason || "")));
}

function isSingleLocalVerificationCommand(command: string): boolean {
  if (!command.trim() || command.length > 4000 || /[;&|<>`$(){}*?\[\]\\\n\r\0]/.test(command)) return false;
  const tokens = tokenizeInspectionCommand(command);
  if (!tokens.length) return false;
  // Keep targets inside the ordinary workspace; options with path values must
  // obey the same boundary. The process sandbox enforces the effective grants.
  if (tokens.some((token) => !pathTokenAllowed(token))) return false;
  const [name, ...args] = tokens;
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
    const script = args[0] === "run" ? args[1] : args[0];
    return /^(?:test(?::[\w-]+)?|lint(?::[\w-]+)?|typecheck|check|build)$/.test(script || "")
      && !hasFlag(args, PACKAGE_MUTATING_OR_WATCH_FLAGS)
      && !args.some((arg) => /^-[A-Za-z]*u[A-Za-z]*$/.test(arg));
  }
  let checkArgs = args;
  if (name === "python" || name === "python3") {
    let index = 0;
    while (["-B", "-I", "-s", "-E"].includes(args[index])) index += 1;
    if (args[index] !== "-m") return false;
    const module = args[index + 1];
    checkArgs = args.slice(index + 2);
    if (module === "unittest") return true;
    if (module === "pytest") return !hasJoinedFlag(checkArgs, ["--basetemp", "--override-ini", "-o"]);
    if (module !== "ruff") return false;
  } else if (name === "pytest") {
    return !hasJoinedFlag(checkArgs, ["--basetemp", "--override-ini", "-o"]);
  } else if (name !== "ruff") return false;
  return checkArgs[0] === "check"
    && !hasFlag(checkArgs, RUFF_MUTATING_OR_OUTPUT_FLAGS);
}

/**
 * Strictly decompose a reusable local verification shell command.
 * Accepts either one allowed check, an && chain of allowed checks, or one safe
 * relative `cd <dir> &&` prefix followed by allowed checks. It intentionally
 * rejects pipes, redirection, ||, ;, substitutions, glob metacharacters, and
 * arbitrary shell assignments so medium approval cannot cover compatibility
 * shell behavior outside local verification.
 */
export function planLocalVerificationCommand(command: string): LocalVerificationCommandPlan | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 4000) return null;
  if (/[|;<>`$(){}*?\[\]\\\n\r\0]/.test(trimmed)) return null;
  if (trimmed.replace(/&&/g, "").includes("&")) return null;
  const parts = trimmed.split(/\s*&&\s*/).map((part) => part.trim());
  if (!parts.length || parts.some((part) => !part)) return null;

  let cwd: string | undefined;
  let commands = parts;
  const firstTokens = tokenizeInspectionCommand(parts[0]);
  if (firstTokens[0] === "cd") {
    if (parts.length < 2 || firstTokens.length !== 2) return null;
    const target = firstTokens[1];
    if (!target || target.startsWith("-") || target.startsWith("/") || target.startsWith("~") || /^[A-Za-z]:/.test(target) || target.split("/").includes("..")) return null;
    if (target !== "." && !evaluateContextPath(target).allowed) return null;
    cwd = target;
    commands = parts.slice(1);
  }

  if (!commands.length || commands.some((part) => tokenizeInspectionCommand(part)[0] === "cd" || !isSingleLocalVerificationCommand(part))) return null;
  return { ...(cwd ? { cwd } : {}), commands };
}

/** Recognize local checks, not arbitrary shells, installers, or fix commands.
 * These still execute project code and require workspace-scoped approval. */
export function isLocalVerificationCommand(command: string): boolean {
  return Boolean(planLocalVerificationCommand(command));
}
