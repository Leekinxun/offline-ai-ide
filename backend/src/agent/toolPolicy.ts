import path from "path";
import fs from "node:fs";
import { safePath } from "../utils/safePath.js";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ShellPolicyOptions {
  /** A shell string is never accepted unless the caller explicitly opts in. */
  compatibilityShellAuthorized?: boolean;
  /** Policy preflight only. The executor still needs a one-time trusted grant. */
  networkAccessAuthorized?: boolean;
  /** Required to prove that an absolute output path stays inside the workspace. */
  workspaceDir?: string;
}

const PROTECTED_SEGMENTS = new Set([
  ".git",
  ".history",
  ".checkpoints",
  ".team",
  ".codex",
  ".omx",
  ".crewforge",
]);
const PROTECTED_FILES = new Set(["users.json", "app-settings.json"]);
const AGENT_SHELL_NETWORK_BLOCKED =
  "Agent shell network is blocked; use a configured MCP/integration or the user terminal for explicit network access";

const NETWORK_COMMAND_PATTERNS: RegExp[] = [
  // Direct egress and remote-login clients, including absolute executable paths.
  /\b(?:curl|wget|nc|netcat|socat|ssh|scp|sftp|ftp|telnet)\b/i,
  // Package operations that normally contact registries. Local scripts such as
  // `npm test` and `npm run build` intentionally do not match.
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|ci|install|add|update|upgrade|publish|login|whoami|view|info|search|fetch)\b/i,
  /\b(?:pip|pip3|pipx|gem)\s+(?:install|download|update|push|login|search)\b/i,
  /\b(?:cargo)\s+(?:install|publish|search|login)\b/i,
  /\bgo\s+(?:get|install)\b/i,
  /\b(?:composer)\s+(?:install|update|require)\b/i,
  /\b(?:brew|apt|apt-get|dnf|yum|apk)\s+(?:install|update|upgrade)\b/i,
  /\bdotnet\s+(?:add\s+\S+\s+package|tool\s+install|nuget\s+push)\b/i,
  /\bnuget\s+(?:install|restore|push)\b/i,
  // Git operations whose purpose includes contacting a remote. Local status,
  // diff, show, log, add, and commit remain governed by the other rules.
  /\bgit(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree)(?:=\S+|\s+\S+)))*\s+(?:fetch|pull|push|clone|ls-remote)\b/i,
  /\bgit\s+remote\s+(?:update|prune)\b/i,
  /\bgit\s+submodule\s+(?:update|sync|foreach)\b/i,
  // Cloud and cluster clients are network-capable even when a particular
  // subcommand might only inspect local configuration.
  /\b(?:aws|gcloud|az|doctl|heroku|vercel|netlify|flyctl|kubectl|helm|terraform|pulumi|wrangler)\b/i,
];

// An egress grant does not authorize publishing, credential changes, tunnels,
// remote administration, or host package management.
const NON_OVERRIDABLE_NETWORK_PATTERNS: RegExp[] = [
  /\b(?:nc|netcat|socat|ssh|scp|sftp|ftp|telnet|rsync|rclone)\b/i,
  /\b(?:aws|gcloud|az|doctl|heroku|vercel|netlify|flyctl|kubectl|helm|terraform|pulumi|wrangler)\b/i,
  /\b(?:brew|apt|apt-get|dnf|yum|apk)\b/i,
  /\bgit\b[^\n;&|]*\b(?:push|send-email)\b/i,
  /\b(?:npm|pnpm|yarn|bun|pip|pip3|pipx|gem|cargo|nuget|dotnet)\b[^\n;&|]*\b(?:publish|unpublish|push|login|logout|deprecate|owner|access|token)\b/i,
  /\b(?:curl|wget)\b[^\n;&|]*\s-[A-Za-z]*[XdFTK]/,
  /\b(?:curl|wget)\b[^\n;&|]*\s--(?:request|method|config|data(?:-[a-z]+)?|form(?:-string)?|json|upload-file|post-data|post-file|body-data|body-file)(?:=|\s)/i,
];

export function evaluateWorkspaceWrite(targetPath: string): PolicyDecision {
  const normalized = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter(Boolean);
  if (!normalized || path.posix.isAbsolute(normalized) || segments.includes("..")) {
    return { allowed: false, reason: "The target must be a relative workspace path" };
  }
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    return { allowed: false, reason: "Agent writes to workspace metadata are blocked" };
  }
  if (PROTECTED_FILES.has(segments.at(-1) || "")) {
    return { allowed: false, reason: "Agent writes to application credential/config files are blocked" };
  }
  if (/(^|\/)\.env(?:\.|$)/i.test(normalized) || /(?:credentials|secrets?)\.(?:json|ya?ml|toml)$/i.test(normalized)) {
    return { allowed: false, reason: "Agent writes to secret-bearing files require manual editing" };
  }
  return { allowed: true };
}

interface ShellToken { kind: "word" | "operator"; value: string; literal?: boolean; }
function shellTokens(command: string): ShellToken[] | null {
  const result: ShellToken[] = [];
  let value = ""; let started = false; let literal = true; let quote: "'" | '"' | undefined;
  const flush = () => { if (started) result.push({ kind: "word", value, literal }); value = ""; started = false; literal = true; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") { if (character === "'") quote = undefined; else value += character; continue; }
    if (character === "\\") {
      const next = command[++index]; if (next === undefined) return null;
      if (next === "\n") continue;
      started = true;
      if (quote === '"' && !['$', '`', '"', "\\"].includes(next)) value += "\\";
      value += next; continue;
    }
    if (quote === '"') { if (character === '"') quote = undefined; else { if (character === "$" || character === "`") literal = false; value += character; } continue; }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/.test(character)) { flush(); if (character === "\n") result.push({ kind: "operator", value: ";" }); continue; }
    if (";&|<>".includes(character)) {
      flush();
      const operator = ["&>>", "<<<", ">>", "<<", "<>", ">&", "<&", ">|", "&>", "&&", "||", ";;"].find((item) => command.startsWith(item, index)) || character;
      result.push({ kind: "operator", value: operator }); index += operator.length - 1; continue;
    }
    started = true;
    if ("$`*?[".includes(character)) literal = false;
    value += character;
  }
  if (quote) return null;
  flush(); return result;
}

function outputTargetPolicy(target: ShellToken, workspaceDir?: string): PolicyDecision {
  if (target.kind !== "word" || !target.value || !target.literal) return { allowed: false, reason: "Output redirection requires a literal workspace path or /dev/null" };
  if (target.value === "/dev/null") return { allowed: true };
  if (target.value.startsWith("~")) return { allowed: false, reason: "Redirection outside the workspace is blocked" };
  let relative = target.value;
  if (path.isAbsolute(target.value)) {
    if (!workspaceDir) return { allowed: false, reason: "Absolute output redirection requires an explicit workspace boundary" };
    relative = path.relative(path.resolve(workspaceDir), path.resolve(target.value));
  } else relative = path.normalize(relative);
  const policy = evaluateWorkspaceWrite(relative);
  if (!policy.allowed) return { allowed: false, reason: policy.reason?.includes("relative workspace") ? "Redirection outside the workspace is blocked" : policy.reason };
  if (workspaceDir) {
    try {
      const targetPath = safePath(relative, workspaceDir);
      let cursor = path.resolve(workspaceDir);
      for (const part of path.relative(cursor, targetPath).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        try { if (fs.lstatSync(cursor).isSymbolicLink()) return { allowed: false, reason: "Output redirection cannot traverse symbolic links" }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
      }
    } catch { return { allowed: false, reason: "Output redirection cannot escape the workspace or use an unavailable path" }; }
  }
  return { allowed: true };
}

function shellRedirectionPolicy(command: string, workspaceDir?: string): PolicyDecision {
  const tokens = shellTokens(command);
  if (!tokens) return { allowed: false, reason: "Shell command has an unterminated quote or escape" };
  let commandPosition = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "operator" && [";", ";;", "&&", "||", "|", "&"].includes(token.value)) { commandPosition = true; continue; }
    if (token.kind === "operator" && [">", ">>", ">|", "<", "<>", ">&", "<&", "<<", "<<<", "&>", "&>>"].includes(token.value)) {
      if (["<<", "<<<", "&>", "&>>"].includes(token.value)) return { allowed: false, reason: "Use literal file redirection and numeric descriptor duplication instead of this shell redirection form" };
      const target = tokens[++index];
      if (!target || target.kind !== "word") return { allowed: false, reason: "Shell redirection is missing a target" };
      if (token.value === ">&" || token.value === "<&") {
        if (!target.literal || !/^(?:\d+|-)$/.test(target.value)) return { allowed: false, reason: "Descriptor duplication requires a numeric descriptor or '-'" };
      } else if (token.value !== "<") {
        const policy = outputTargetPolicy(target, workspaceDir); if (!policy.allowed) return policy;
      }
      continue;
    }
    if (token.kind !== "word") continue;
    if (commandPosition && (["do", "then", "else", "elif", "if", "while", "until", "!"].includes(token.value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value))) continue;
    const isCommand = commandPosition; commandPosition = false;
    // tee opens its operands for writing even though it is not shell syntax.
    if (isCommand && token.literal && path.basename(token.value) === "tee") {
      let optionsEnded = false;
      for (let next = index + 1; next < tokens.length && tokens[next].kind === "word"; next += 1) {
        if (!optionsEnded && tokens[next].value === "--") { optionsEnded = true; continue; }
        if (!optionsEnded && tokens[next].value.startsWith("-")) continue;
        const policy = outputTargetPolicy(tokens[next], workspaceDir); if (!policy.allowed) return policy;
      }
    }
  }
  return { allowed: true };
}

export function evaluateShellCommand(command: string, options: ShellPolicyOptions = {}): PolicyDecision {
  const normalized = command.trim();
  if (!normalized) return { allowed: false, reason: "Empty command" };
  if (/\0|\r/.test(normalized)) return { allowed: false, reason: "Invalid command characters" };

  // Commands are passed to a shell by the legacy executor. Reject shell syntax
  // by default so callers cannot accidentally treat unstructured text as exec.
  // The executor may opt in only after a high-risk tool approval has succeeded.
  if (!options.compatibilityShellAuthorized && /(?:[;&|`]|\$\(|\$\{|\(\s*\)|\n|>|<)/.test(normalized)) {
    return { allowed: false, reason: "Shell syntax requires explicit compatibility-shell authorization" };
  }

  const rules: Array<[RegExp, string]> = [
    ...(options.networkAccessAuthorized
      ? NON_OVERRIDABLE_NETWORK_PATTERNS.map((pattern): [RegExp, string] => [pattern, "Network approval does not authorize publishing, remote/system control, credentials, or remote mutations"])
      : NETWORK_COMMAND_PATTERNS.map((pattern): [RegExp, string] => [pattern, AGENT_SHELL_NETWORK_BLOCKED])),
    [/\bsudo\b/i, "Privilege escalation is blocked"],
    [/\b(?:shutdown|reboot|halt|poweroff|launchctl|systemctl)\b/i, "System control commands are blocked"],
    [/\b(?:mkfs|fdisk|diskutil|dd)\b/i, "Disk modification commands are blocked"],
    [/\b(?:chmod|chown|chgrp)\b/i, "Permission and ownership changes require manual approval"],
    [/(?:^|[;&|]\s*)rm\s/i, "File deletion requires manual approval"],
    [/\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f|checkout\s+--\s+\.|restore\s+\.)/i, "Destructive Git commands are blocked"],
    [/(?:curl|wget)[^\n|;&]*\|\s*(?:sh|bash|zsh|python|node)\b/i, "Downloaded code cannot be piped directly to an interpreter"],
    [/\b(?:sh|bash|zsh|fish|dash|ksh)\s+(?:-c|--command)\b/i, "Nested shell interpreters are blocked"],
    [/\b(?:node|python(?:3)?|ruby|perl|php)\s+(?:-e|-c)\b/i, "Inline interpreter execution is blocked"],
    [/(?:\$\(|`|\$\{|\(\s*)/, "Command substitution and subshells are blocked"],
    [/(?:^|\s)(?:\/etc|\/usr|\/bin|\/sbin|\/System|\/Library|~\/\.ssh|~\/\.aws)(?:\/|\s|$)/i, "Commands targeting system or credential directories are blocked"],
    [/(?:^|[\s"'=])(?:\.\/)?\.crewforge(?:\/|[\s"'=]|$)/i, "Agent shell access to CrewForge control metadata is blocked"],
    [/(?:^|[\s;])(?:\.\.\/)+/i, "Commands cannot escape the workspace"],
  ];
  for (const [pattern, reason] of rules) {
    if (pattern.test(normalized)) return { allowed: false, reason };
  }
  return shellRedirectionPolicy(normalized, options.workspaceDir);
}
