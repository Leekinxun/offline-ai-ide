import type { ExecutionPlan } from "../chat/executionPlans.js";
import type { AgentMode } from "./types.js";
import {
  amendmentRequired,
  resolveCodeExecutionContract,
} from "./executionContract.js";
import { evaluateContextPath } from "./contextPolicy.js";
import { usesNativeWindowsAgent } from "./windowsShell.js";

export interface ModeCapabilityDecision {
  allowed: boolean;
  reason?: string;
  decision?: "amendment_required";
  amendmentRequired?: boolean;
  requiresReplan?: boolean;
}

const INSPECTION_TOOLS = new Set([
  "ask_user",
  "compress",
  "read_run_evidence",
  "memory_read",
  "skill_load",
  "read_file",
  "find_files",
  "search_files",
  "list_directory",
  "TodoWrite",
]);

export function evaluateModeCapability(options: {
  mode: AgentMode;
  toolName: string;
  input: Record<string, unknown>;
  executionPlan?: ExecutionPlan;
}): ModeCapabilityDecision {
  const { mode, toolName, input, executionPlan } = options;

  if (mode === "ask") {
    return INSPECTION_TOOLS.has(toolName)
      ? { allowed: true }
      : denied("Ask mode is limited to inspection and explanation");
  }

  if (mode === "plan") {
    if (INSPECTION_TOOLS.has(toolName) || toolName === "submit_plan") return { allowed: true };
    if (toolName === "bash") return evaluateInspectionCommand(input.command);
    return denied("Plan mode cannot modify files, execute side-effecting tools, or persist task state");
  }

  if (mode === "review") {
    if (INSPECTION_TOOLS.has(toolName)) return { allowed: true };
    if (toolName === "bash") return evaluateInspectionCommand(input.command);
    if (toolName === "report_review_finding") return { allowed: true };
    return denied("Review mode is read-only and cannot modify workspace state");
  }

  if (toolName === "report_review_finding") {
    return denied("report_review_finding is only available in Review mode");
  }

  const contract = resolveCodeExecutionContract(executionPlan);
  if (toolName === "request_plan_amendment" && contract.kind === "direct_code") {
    return denied("Plan-amendment requests are only available while executing an approved plan");
  }
  if (contract.kind === "direct_code") return { allowed: true };
  const approvedPlan = contract.plan;
  if (INSPECTION_TOOLS.has(toolName)) return { allowed: true };
  if (toolName === "process_poll" || toolName === "process_stop") return { allowed: true };
  if (toolName === "process_input") return amendmentRequired("Interactive process input is not covered by the approved plan; use an approved non-interactive verification command");
  if (toolName === "submit_completion_evidence") return { allowed: true };
  if (toolName === "request_plan_amendment") return { allowed: true };

  if (toolName === "write_file" || toolName === "edit_file") {
    const target = typeof input.path === "string" ? normalizePath(input.path) : "";
    const allowed = approvedPlan.files.some((entry) => scopeContains(entry, target));
    return allowed
      ? { allowed: true }
      : amendmentRequired(
          `Execution plan scope violation: ${target || "missing path"} is not in the approved file scope`
        );
  }

  if (toolName === "rename_file") {
    const paths = [input.source_path, input.target_path].map((value) => typeof value === "string" ? normalizePath(value) : "");
    const outside = paths.find((target) => !target || !approvedPlan.files.some((entry) => scopeContains(entry, target)));
    return outside === undefined ? { allowed: true } : amendmentRequired(`Execution plan scope violation: both rename paths must be in the approved file scope (${outside || "missing path"})`);
  }

  if (toolName === "bash" || toolName === "process_start") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (approvedPlan.verificationCommands.includes(command)) return { allowed: true };
    const inspection = evaluateInspectionCommand(command);
    return inspection.allowed
      ? inspection
      : amendmentRequired(
          "Execution plan scope violation: shell commands must be read-only inspection commands or an approved verification command"
        );
  }

  return amendmentRequired(
    `Execution plan scope violation: ${toolName} is not part of the approved execution capability set`
  );
}

type InspectionPathValidator = (candidate: string) => ModeCapabilityDecision;

export function evaluateInspectionCommand(commandValue: unknown, validatePath?: InspectionPathValidator): ModeCapabilityDecision {
  const command = typeof commandValue === "string" ? commandValue.trim() : "";
  if (!command) return denied("Inspection command is empty");
  if (/\n|\r|[;&|><`]|\$\(/.test(command)) {
    return denied("Inspection commands cannot contain shell composition or redirection");
  }
  const tokens = tokenizeInspectionCommand(command);
  if (!tokens.length) return denied("Inspection command is empty");
  if (tokens.some((token) => token.includes("\0"))) return denied("Inspection command contains an invalid argument");

  const powershellName = tokens[0].toLowerCase();
  if (["get-location", "get-childitem", "get-content"].includes(powershellName) && usesNativeWindowsAgent()) {
    if (/[$(){}]/.test(command)) return denied("PowerShell inspection requires literal arguments");
    if (powershellName === "get-location") return tokens.length === 1 ? { allowed: true } : denied("Get-Location does not accept arguments in read-only modes");
    const paths: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const flag = tokens[i].toLowerCase();
      if ((powershellName === "get-childitem" && ["-force", "-name"].includes(flag)) || (powershellName === "get-content" && flag === "-raw")) continue;
      if (flag === "-literalpath") {
        if (!tokens[i + 1]) return denied("LiteralPath requires a workspace path");
        paths.push(tokens[++i]); continue;
      }
      if (powershellName === "get-content" && ["-totalcount", "-tail"].includes(flag)) {
        if (!/^\d+$/.test(tokens[i + 1] || "") || Number(tokens[i + 1]) > 100_000) return denied("Content line count must be bounded");
        i++; continue;
      }
      if (flag.startsWith("-")) return denied("Unsupported PowerShell inspection argument");
      paths.push(tokens[i]);
    }
    if (powershellName === "get-content" && !paths.length) return denied("Get-Content requires a workspace file");
    return requireSafePathArguments(paths.length ? paths : ["."], validatePath);
  }

  switch (tokens[0]) {
    case "pwd":
      return tokens.length === 1 ? { allowed: true } : denied("pwd does not accept arguments in read-only modes");
    case "rg":
    case "grep":
      return evaluateSearchLikeCommand(tokens, validatePath);
    case "sed":
      return evaluateSedCommand(tokens, validatePath);
    case "ls":
    case "cat":
    case "head":
    case "tail":
    case "wc":
      return evaluateFileInspectionCommand(tokens, validatePath);
    case "find":
      return evaluateFindCommand(tokens, validatePath);
    case "git":
      return evaluateGitInspectionCommand(tokens, validatePath);
    default:
      return denied("Only read-only repository inspection commands are available in this mode");
  }
}

export function tokenizeInspectionCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) return [];
  if (current) tokens.push(current);
  return tokens;
}

function isSafeRepositoryPath(value: string): boolean {
  if (!value || value === ".") return true;
  if (value === "--") return true;
  if (value.startsWith("-")) return true;
  if (value.startsWith("~") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes(":") && !value.startsWith("./")) return false;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return true;
  return evaluateContextPath(normalized).allowed;
}

function requireSafePathArguments(paths: string[], validatePath?: InspectionPathValidator): ModeCapabilityDecision {
  for (const candidate of paths) {
    if (!isSafeRepositoryPath(candidate)) {
      return denied(`Inspection command path is not authorized: ${candidate}`);
    }
    if (validatePath) {
      const decision = validatePath(candidate);
      if (!decision.allowed) return decision;
    }
  }
  return { allowed: true };
}

function evaluateSearchLikeCommand(tokens: string[], validatePath?: InspectionPathValidator): ModeCapabilityDecision {
  const optionsWithValues = new Set(["-e", "--regexp", "-g", "--glob", "-t", "--type", "-T", "--type-not", "--max-count", "-m", "--context", "-C", "--after-context", "-A", "--before-context", "-B"]);
  const allowedFlags = new Set([
    "-n", "--line-number", "-i", "--ignore-case", "-S", "--smart-case", "-s", "--case-sensitive",
    "-F", "--fixed-strings", "-w", "--word-regexp", "-l", "--files-with-matches", "-L",
    "--files-without-match", "--count", "-c", "--heading", "--no-heading", "--color=never",
    "--json", "--stats", "--vimgrep", "-H", "--with-filename",
  ]);
  const deniedFlags = new Set(["--pre", "--pre-glob", "--no-ignore", "--hidden", "--follow", "-u", "-uu", "-uuu", "--unrestricted", "--search-zip", "-z", "--null-data"]);
  const paths: string[] = [];
  let patternSeen = false;
  let optionsEnded = false;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (optionsEnded) {
      if (patternSeen) paths.push(token);
      else patternSeen = true;
      continue;
    }
    if (token === "--") { optionsEnded = true; continue; }
    if (deniedFlags.has(token) || Array.from(deniedFlags).some((flag) => token.startsWith(`${flag}=`))) {
      return denied("Inspection search commands cannot use flags that bypass repository policy");
    }
    if (optionsWithValues.has(token)) {
      i += 1;
      if (i >= tokens.length) return denied("Inspection command option is missing a value");
      if (token === "-e" || token === "--regexp") patternSeen = true;
      continue;
    }
    if (Array.from(optionsWithValues).some((flag) => token.startsWith(`${flag}=`))) {
      if (token.startsWith("--regexp=")) patternSeen = true;
      continue;
    }
    if (allowedFlags.has(token) || /^-[niSFwlcH]+$/.test(token)) continue;
    if (token.startsWith("-")) return denied(`Inspection search option is not allowed: ${token}`);
    if (patternSeen) paths.push(token);
    else patternSeen = true;
  }
  return requireSafePathArguments(paths.length ? paths : ["."], validatePath);
}

function evaluateSedCommand(tokens: string[], validatePath?: InspectionPathValidator): ModeCapabilityDecision {
  if (tokens.length < 4 || tokens[1] !== "-n" || !/^(?:\d+|\$)?(?:,(?:\d+|\$))?p$/.test(tokens[2])) {
    return denied("sed is limited to sed -n range printing in read-only modes");
  }
  const paths: string[] = [];
  for (let i = 3; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-i" || token.startsWith("-i")) return denied("sed in-place editing is unavailable in read-only modes");
    if (token.startsWith("-")) return denied(`sed option is not allowed: ${token}`);
    paths.push(token);
  }
  if (!paths.length) return denied("sed inspection requires a file path");
  return requireSafePathArguments(paths.length ? paths : ["."], validatePath);
}

function evaluateFileInspectionCommand(tokens: string[], validatePath?: InspectionPathValidator): ModeCapabilityDecision {
  const command = tokens[0];
  const paths: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") continue;
    if (command === "ls" && /^(?:-[aAdfghiklmnoprstux1]+|--color=never)$/.test(token)) continue;
    if ((command === "head" || command === "tail") && (token === "-n" || token === "-c")) {
      i += 1;
      if (!/^\d+$/.test(tokens[i] || "")) return denied(`${command} limit must be numeric`);
      continue;
    }
    if ((command === "head" || command === "tail") && /^-[nc]?\d+$/.test(token)) continue;
    if (command === "wc" && /^-[clmwL]+$/.test(token)) continue;
    if (command === "cat" && /^-[benstuvAET]+$/.test(token)) continue;
    if (token.startsWith("-")) return denied(`${command} option is not allowed: ${token}`);
    paths.push(token);
  }
  return requireSafePathArguments(paths.length ? paths : ["."], validatePath);
}

function evaluateFindCommand(tokens: string[], validatePath?: InspectionPathValidator): ModeCapabilityDecision {
  const optionsWithValues = new Set(["-maxdepth", "-mindepth", "-name", "-iname", "-path", "-type"]);
  const allowedActions = new Set(["-print", "-print0"]);
  const deniedActions = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);
  const paths: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (deniedActions.has(token)) return denied("Mutating or file-writing find actions are unavailable in read-only modes");
    if (optionsWithValues.has(token)) {
      i += 1;
      if (i >= tokens.length) return denied("find option is missing a value");
      if ((token === "-maxdepth" || token === "-mindepth") && !/^\d+$/.test(tokens[i])) return denied("find depth must be numeric");
      if (token === "-type" && !/^[fdl]$/.test(tokens[i])) return denied("find type must be f, d, or l");
      continue;
    }
    if (allowedActions.has(token) || token === "(" || token === ")" || token === "-o" || token === "-a" || token === "!") continue;
    if (token.startsWith("-")) return denied(`find option is not allowed: ${token}`);
    paths.push(token);
  }
  return requireSafePathArguments(paths.length ? paths : ["."], validatePath);
}

function evaluateGitInspectionCommand(tokens: string[], validatePath?: InspectionPathValidator): ModeCapabilityDecision {
  const subcommand = tokens[1];
  if (!subcommand) return denied("git inspection requires a subcommand");
  if (subcommand === "branch") {
    return tokens.length === 3 && tokens[2] === "--show-current"
      ? { allowed: true }
      : denied("git branch is limited to --show-current in read-only modes");
  }
  if (subcommand === "status") return evaluateGitArgs(tokens.slice(2), new Set(["--short", "-s", "--porcelain", "--branch", "-b"]), validatePath);
  if (subcommand === "rev-parse") return evaluateGitArgs(tokens.slice(2), new Set(["--show-toplevel", "--show-prefix", "--abbrev-ref", "--verify", "--short", "HEAD"]), validatePath);
  if (subcommand === "ls-files") return evaluateGitArgs(tokens.slice(2), new Set(["--cached", "--deleted", "--modified", "--others", "--exclude-standard", "-m", "-d", "-o"]), validatePath);
  if (subcommand === "diff" || subcommand === "show" || subcommand === "log") {
    const denied = ["--output", "--ext-diff", "--textconv", "--no-index", "--config", "-c", "--config-env"];
    if (tokens.slice(2).some((token) => denied.some((flag) => token === flag || token.startsWith(`${flag}=`)))) {
      return deniedResult("git inspection cannot use output, external diff, textconv, config, or no-index flags");
    }
    return evaluateGitArgs(tokens.slice(2), new Set([
      "--", "--stat", "--name-only", "--name-status", "--oneline", "--decorate", "--no-ext-diff",
      "--no-textconv", "--color=never", "-p", "-U0", "-U1", "-U2", "-U3", "HEAD", "HEAD~1",
    ]), validatePath);
  }
  return denied("Only read-only git status, diff, show, log, rev-parse, ls-files, and branch --show-current are available");
}

function evaluateGitArgs(args: string[], allowedFlagsAndLiterals: Set<string>, validatePath?: InspectionPathValidator): ModeCapabilityDecision {
  const paths: string[] = [];
  let afterPathSeparator = false;
  for (const token of args) {
    if (token.includes(":")) return denied("git object paths are unavailable in read-only inspection commands; use read_file instead");
    if (token === "--") {
      afterPathSeparator = true;
      continue;
    }
    if (afterPathSeparator) {
      paths.push(token);
      continue;
    }
    if (allowedFlagsAndLiterals.has(token) || /^-[0-9]+$/.test(token) || /^--max-count=\d+$/.test(token) || /^-[US]\d+$/.test(token)) continue;
    if (token.startsWith("-")) return denied(`git inspection option is not allowed: ${token}`);
    if (token.includes("/") || token.startsWith(".") || token.includes("\\")) paths.push(token);
  }
  return requireSafePathArguments(paths.length ? paths : ["."], validatePath);
}

function deniedResult(reason: string): ModeCapabilityDecision {
  return denied(reason);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function scopeContains(scopeValue: string, targetValue: string): boolean {
  const scope = normalizePath(scopeValue);
  const target = normalizePath(targetValue);
  return Boolean(scope && target && (scope === target || target.startsWith(`${scope}/`)));
}

function denied(reason: string): ModeCapabilityDecision {
  return { allowed: false, reason };
}
