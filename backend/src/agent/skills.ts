import fs from "node:fs";
import path from "node:path";

const MAX_SKILL_BODY = 24_000;
const MAX_SKILLS_IN_PROMPT = 32;

export interface WorkspaceSkill {
  name: string;
  description: string;
  trigger: string;
  tags: string;
  path: string;
  body: string;
}

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

export function loadWorkspaceSkill(workspaceDir: string, name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Skill name is required");
  }
  const skill = listWorkspaceSkills(workspaceDir).find((item) => item.name === name.trim());
  if (!skill) throw new Error(`Skill not found: ${name}`);
  return `# Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.body}`;
}

export function buildSkillsPrompt(workspaceDir: string): string {
  const skills = listWorkspaceSkills(workspaceDir).slice(0, MAX_SKILLS_IN_PROMPT);
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
  };
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
