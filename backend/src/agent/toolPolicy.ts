import path from "path";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ShellPolicyOptions {
  /** A shell string is never accepted unless the caller explicitly opts in. */
  compatibilityShellAuthorized?: boolean;
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
    ...NETWORK_COMMAND_PATTERNS.map((pattern): [RegExp, string] => [pattern, AGENT_SHELL_NETWORK_BLOCKED]),
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
    [/(?:^|[;&|]\s*)[^\s]+\s*(?:>|>>|<|<<|<<<)/, "Shell redirection requires manual file operations"],
    [/(?:^|\s)(?:\/etc|\/usr|\/bin|\/sbin|\/System|\/Library|~\/\.ssh|~\/\.aws)(?:\/|\s|$)/i, "Commands targeting system or credential directories are blocked"],
    [/(?:^|[\s"'=])(?:\.\/)?\.crewforge(?:\/|[\s"'=]|$)/i, "Agent shell access to CrewForge control metadata is blocked"],
    [/(?:^|[\s;])(?:\.\.\/)+/i, "Commands cannot escape the workspace"],
    [/(?:>|>>|tee\s+)(?:\s*)(?:\/|~\/|\.\.\/)/i, "Redirection outside the workspace is blocked"],
  ];
  for (const [pattern, reason] of rules) {
    if (pattern.test(normalized)) return { allowed: false, reason };
  }
  return { allowed: true };
}
