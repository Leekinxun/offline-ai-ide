import fs from "node:fs";
import path from "node:path";

export type MemoryScope = "user" | "workspace";

const CODEX_DIR = ".codex";
const USER_MEMORY_FILE = "USER.md";
const WORKSPACE_MEMORY_FILE = "MEMORY.md";
const USER_MEMORY_LIMIT = 8_000;
const WORKSPACE_MEMORY_LIMIT = 16_000;

export interface MemorySnapshot {
  user: string;
  workspace: string;
  userPath: string;
  workspacePath: string;
}

export interface MemoryManagementEntry {
  scope: MemoryScope;
  path: string;
  content: string;
  exists: boolean;
  characters: number;
  updatedAt?: number;
  limit: number;
}

function memoryPath(workspaceDir: string, scope: MemoryScope): string {
  return path.join(workspaceDir, CODEX_DIR, scope === "user" ? USER_MEMORY_FILE : WORKSPACE_MEMORY_FILE);
}

function readFileIfPresent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export function loadMemorySnapshot(workspaceDir: string): MemorySnapshot {
  const userPath = memoryPath(workspaceDir, "user");
  const workspacePath = memoryPath(workspaceDir, "workspace");
  return {
    user: readFileIfPresent(userPath).slice(0, USER_MEMORY_LIMIT),
    workspace: readFileIfPresent(workspacePath).slice(0, WORKSPACE_MEMORY_LIMIT),
    userPath: path.relative(workspaceDir, userPath),
    workspacePath: path.relative(workspaceDir, workspacePath),
  };
}

export function buildMemoryPrompt(snapshot: MemorySnapshot): string {
  const blocks: string[] = [];
  if (snapshot.user) {
    blocks.push(
      `<user_memory path="${snapshot.userPath}">
Stable user preferences and working conventions loaded at session start:
${snapshot.user}
</user_memory>`
    );
  }
  if (snapshot.workspace) {
    blocks.push(
      `<workspace_memory path="${snapshot.workspacePath}">
Reusable project facts and decisions loaded at session start:
${snapshot.workspace}
</workspace_memory>`
    );
  }
  if (blocks.length === 0) return "";
  return `\n\n## Persistent Memory\nTreat the following as reusable context, not as a replacement for inspecting current files.\n${blocks.join("\n\n")}\n- Only update memory with durable preferences, project conventions, or decisions. Never store secrets or transient task output.`;
}

export function readMemory(workspaceDir: string, scope: unknown): string {
  const normalizedScope = normalizeScope(scope);
  const filePath = memoryPath(workspaceDir, normalizedScope);
  const content = readFileIfPresent(filePath);
  return content || `${scopeLabel(normalizedScope)} is empty. Use memory_write to save durable context.`;
}

export function writeMemory(workspaceDir: string, scope: unknown, content: unknown): string {
  const normalizedScope = normalizeScope(scope);
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Memory content must be a non-empty string");
  }

  const limit = normalizedScope === "user" ? USER_MEMORY_LIMIT : WORKSPACE_MEMORY_LIMIT;
  const normalized = content.trim().slice(0, limit);
  const filePath = memoryPath(workspaceDir, normalizedScope);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${normalized}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
  return `${scopeLabel(normalizedScope)} updated at ${path.relative(workspaceDir, filePath)} (${normalized.length} chars).`;
}

export function listMemoryEntries(workspaceDir: string): MemoryManagementEntry[] {
  return (["user", "workspace"] as MemoryScope[]).map((scope) => {
    const filePath = memoryPath(workspaceDir, scope);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(filePath);
    } catch {
      stat = undefined;
    }
    const content = readFileIfPresent(filePath);
    return {
      scope,
      path: path.relative(workspaceDir, filePath),
      content,
      exists: Boolean(stat),
      characters: content.length,
      ...(stat ? { updatedAt: stat.mtimeMs } : {}),
      limit: scope === "user" ? USER_MEMORY_LIMIT : WORKSPACE_MEMORY_LIMIT,
    };
  });
}

export function deleteMemory(workspaceDir: string, scope: unknown): string {
  const normalizedScope = normalizeScope(scope);
  const filePath = memoryPath(workspaceDir, normalizedScope);
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return `${scopeLabel(normalizedScope)} cleared.`;
}

export function mergeMemory(
  workspaceDir: string,
  sourceScope: unknown,
  targetScope: unknown
): string {
  const source = normalizeScope(sourceScope);
  const target = normalizeScope(targetScope);
  if (source === target) throw new Error("Source and target memory scopes must differ");

  const sourceContent = readFileIfPresent(memoryPath(workspaceDir, source));
  if (!sourceContent) throw new Error(`${scopeLabel(source)} is empty`);
  const targetContent = readFileIfPresent(memoryPath(workspaceDir, target));
  const heading = `\n\n## Imported from ${scopeLabel(source)}\n`;
  const merged = targetContent ? `${targetContent}${heading}${sourceContent}` : sourceContent;
  writeMemory(workspaceDir, target, merged);
  return `${scopeLabel(source)} merged into ${scopeLabel(target)}.`;
}

function normalizeScope(scope: unknown): MemoryScope {
  if (scope === "user" || scope === "workspace") return scope;
  throw new Error('Memory scope must be "user" or "workspace"');
}

function scopeLabel(scope: MemoryScope): string {
  return scope === "user" ? "USER.md" : "MEMORY.md";
}
