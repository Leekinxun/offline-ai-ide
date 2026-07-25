import path from "path";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

const PROTECTED_SEGMENTS = new Set([
  ".git",
  ".history",
  ".checkpoints",
  ".team",
  ".codex",
  ".omx",
]);
const PROTECTED_FILES = new Set(["users.json", "app-settings.json"]);

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

export function evaluateShellCommand(command: string): PolicyDecision {
  const normalized = command.trim();
  if (!normalized) return { allowed: false, reason: "Empty command" };
  if (/\0|\r/.test(normalized)) return { allowed: false, reason: "Invalid command characters" };

  const rules: Array<[RegExp, string]> = [
    [/\bsudo\b/i, "Privilege escalation is blocked"],
    [/\b(?:shutdown|reboot|halt|poweroff|launchctl|systemctl)\b/i, "System control commands are blocked"],
    [/\b(?:mkfs|fdisk|diskutil|dd)\b/i, "Disk modification commands are blocked"],
    [/\b(?:chmod|chown|chgrp)\b/i, "Permission and ownership changes require manual approval"],
    [/(?:^|[;&|]\s*)rm\s/i, "File deletion requires manual approval"],
    [/\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f|checkout\s+--\s+\.|restore\s+\.)/i, "Destructive Git commands are blocked"],
    [/(?:curl|wget)[^\n|;&]*\|\s*(?:sh|bash|zsh|python|node)\b/i, "Downloaded code cannot be piped directly to an interpreter"],
    [/(?:^|\s)(?:\/etc|\/usr|\/bin|\/sbin|\/System|\/Library|~\/\.ssh|~\/\.aws)(?:\/|\s|$)/i, "Commands targeting system or credential directories are blocked"],
    [/(?:^|[\s;])(?:\.\.\/)+/i, "Commands cannot escape the workspace"],
    [/(?:>|>>|tee\s+)(?:\s*)(?:\/|~\/|\.\.\/)/i, "Redirection outside the workspace is blocked"],
  ];
  for (const [pattern, reason] of rules) {
    if (pattern.test(normalized)) return { allowed: false, reason };
  }
  return { allowed: true };
}
