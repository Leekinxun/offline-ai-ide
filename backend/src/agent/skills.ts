import fs from "node:fs";
import path from "node:path";
import { listRunRecords } from "../chat/runHistory.js";

const MAX_SKILL_BODY = 24_000;
const MAX_SKILLS_IN_PROMPT = 32;

export interface WorkspaceSkill {
  name: string;
  description: string;
  trigger: string;
  tags: string;
  path: string;
  body: string;
  metadata: Record<string, string>;
}

export interface ManagedWorkspaceSkill extends Omit<WorkspaceSkill, "body"> {
  enabled: boolean;
  characters: number;
  updatedAt?: number;
  usageCount: number;
  lastUsedAt?: number;
}

export interface SkillUsageRecord {
  runId: string;
  conversationId: string;
  mode: string;
  status: string;
  timestamp: number;
  detail?: string;
}

interface SkillOverrides {
  disabled: string[];
}

const SKILL_OVERRIDES_PATH = path.join(".codex", "skills.json");

export function listWorkspaceSkills(workspaceDir: string): WorkspaceSkill[] {
  const roots = [
    path.join(workspaceDir, ".codex", "skills"),
    path.join(workspaceDir, "skills"),
  ];
  const seen = new Set<string>();
  const skills: WorkspaceSkill[] = [];

  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(root, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = fs.readFileSync(skillPath, "utf-8");
      } catch {
        continue;
      }
      const skill = parseSkill(raw, entry.name, path.relative(workspaceDir, skillPath));
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      skills.push(skill);
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export function listManagedWorkspaceSkills(workspaceDir: string): ManagedWorkspaceSkill[] {
  const skills = listWorkspaceSkills(workspaceDir);
  const disabled = new Set(readSkillOverrides(workspaceDir).disabled);
  const usage = getSkillUsageMap(workspaceDir);
  return skills.map((skill) => {
    const absolutePath = path.join(workspaceDir, skill.path);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      stat = undefined;
    }
    const skillUsage = usage.get(skill.name) || { count: 0 };
    return {
      ...skill,
      enabled: !disabled.has(skill.name),
      characters: skill.body.length,
      ...(stat ? { updatedAt: stat.mtimeMs } : {}),
      usageCount: skillUsage.count,
      ...(skillUsage.lastUsedAt ? { lastUsedAt: skillUsage.lastUsedAt } : {}),
    };
  });
}

export function setWorkspaceSkillEnabled(
  workspaceDir: string,
  name: unknown,
  enabled: unknown
): ManagedWorkspaceSkill {
  if (typeof name !== "string" || !name.trim()) throw new Error("Skill name is required");
  if (typeof enabled !== "boolean") throw new Error("Skill enabled must be a boolean");
  const normalizedName = name.trim();
  if (!listWorkspaceSkills(workspaceDir).some((skill) => skill.name === normalizedName)) {
    throw new Error(`Skill not found: ${normalizedName}`);
  }
  const overrides = readSkillOverrides(workspaceDir);
  const disabled = new Set(overrides.disabled);
  if (enabled) disabled.delete(normalizedName);
  else disabled.add(normalizedName);
  writeSkillOverrides(workspaceDir, [...disabled].sort());
  return listManagedWorkspaceSkills(workspaceDir).find((skill) => skill.name === normalizedName)!;
}

export function getManagedWorkspaceSkill(workspaceDir: string, name: unknown): ManagedWorkspaceSkill & { body: string } {
  if (typeof name !== "string" || !name.trim()) throw new Error("Skill name is required");
  const normalizedName = name.trim();
  const skill = listWorkspaceSkills(workspaceDir).find((item) => item.name === normalizedName);
  if (!skill) throw new Error(`Skill not found: ${normalizedName}`);
  const managed = listManagedWorkspaceSkills(workspaceDir).find((item) => item.name === normalizedName);
  if (!managed) throw new Error(`Skill metadata unavailable: ${normalizedName}`);
  return { ...managed, body: skill.body };
}

export function listSkillUsage(workspaceDir: string, name: unknown, limit = 30): SkillUsageRecord[] {
  if (typeof name !== "string" || !name.trim()) throw new Error("Skill name is required");
  const normalizedName = name.trim();
  return listRunRecords(workspaceDir)
    .flatMap((run) => run.events
      .filter((event) => event.kind === "tool_call" && event.toolName === "skill_load")
      .filter((event) => !event.detail || event.detail === normalizedName)
      .map((event) => ({
        runId: run.runId,
        conversationId: run.conversationId,
        mode: run.mode,
        status: run.status,
        timestamp: event.timestamp,
        ...(event.detail ? { detail: event.detail } : {}),
      })))
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export function loadWorkspaceSkill(workspaceDir: string, name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Skill name is required");
  }
  const skill = listWorkspaceSkills(workspaceDir).find((item) => item.name === name.trim());
  if (!skill) throw new Error(`Skill not found: ${name}`);
  if (!isWorkspaceSkillEnabled(workspaceDir, skill.name)) {
    throw new Error(`Skill is disabled: ${skill.name}`);
  }
  return `# Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.body}`;
}

export function buildSkillsPrompt(workspaceDir: string): string {
  const skills = listWorkspaceSkills(workspaceDir)
    .filter((skill) => isWorkspaceSkillEnabled(workspaceDir, skill.name))
    .slice(0, MAX_SKILLS_IN_PROMPT);
  if (skills.length === 0) return "";

  const catalog = skills
    .map((skill) => {
      const metadata = [
        skill.description && `description=${skill.description}`,
        skill.trigger && `trigger=${skill.trigger}`,
        skill.tags && `tags=${skill.tags}`,
      ].filter(Boolean).join("; ");
      return `- ${skill.name} (${skill.path})${metadata ? ` — ${metadata}` : ""}`;
    })
    .join("\n");

  return `\n\n## Workspace Skills\nThe workspace provides reusable SKILL.md workflows. Load a relevant skill with the skill_load tool before following it; do not assume its body from the name alone.\n${catalog}`;
}

function parseSkill(raw: string, folderName: string, relativePath: string): WorkspaceSkill {
  const normalized = raw.replace(/^\uFEFF/, "");
  let metadata: Record<string, string> = {};
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    if (end >= 0) {
      metadata = parseFrontmatter(normalized.slice(4, end));
      body = normalized.slice(end + "\n---".length).replace(/^\s+/, "");
    }
  }

  return {
    name: metadata.name?.trim() || folderName,
    description: metadata.description?.trim() || firstHeading(body) || "Reusable workspace workflow",
    trigger: metadata.trigger?.trim() || "",
    tags: metadata.tags?.trim() || "",
    path: relativePath,
    body: body.trim().slice(0, MAX_SKILL_BODY),
    metadata,
  };
}

function isWorkspaceSkillEnabled(workspaceDir: string, name: string): boolean {
  return !new Set(readSkillOverrides(workspaceDir).disabled).has(name);
}

function readSkillOverrides(workspaceDir: string): SkillOverrides {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspaceDir, SKILL_OVERRIDES_PATH), "utf-8")) as Partial<SkillOverrides>;
    return {
      disabled: Array.isArray(parsed.disabled)
        ? parsed.disabled.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    };
  } catch {
    return { disabled: [] };
  }
}

function writeSkillOverrides(workspaceDir: string, disabled: string[]): void {
  const filePath = path.join(workspaceDir, SKILL_OVERRIDES_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ disabled }, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function getSkillUsageMap(workspaceDir: string): Map<string, { count: number; lastUsedAt?: number }> {
  const usage = new Map<string, { count: number; lastUsedAt?: number }>();
  for (const run of listRunRecords(workspaceDir)) {
    for (const event of run.events) {
      if (event.kind !== "tool_call" || event.toolName !== "skill_load" || !event.detail) continue;
      const current = usage.get(event.detail) || { count: 0 };
      current.count += 1;
      current.lastUsedAt = Math.max(current.lastUsedAt || 0, event.timestamp);
      usage.set(event.detail, current);
    }
  }
  return usage;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    metadata[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return metadata;
}

function firstHeading(body: string): string {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
}
