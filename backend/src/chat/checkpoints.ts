import crypto from "crypto";
import fs from "fs";
import path from "path";

const CHECKPOINT_DIR = ".checkpoints";
const INDEX_FILE = "index.json";
const MAX_CHECKPOINTS = 12;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const EXCLUDED_NAMES = new Set([
  ".git",
  ".history",
  ".checkpoints",
  ".team",
  ".codex",
  ".omx",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".cache",
]);

export interface WorkspaceCheckpoint {
  id: string;
  label: string;
  createdAt: number;
  conversationId?: string;
  runId?: string;
  kind?: "manual" | "run" | "step" | "revert";
  toolCallId?: string;
  fileCount: number;
  totalBytes: number;
  files: string[];
}

export type PublicWorkspaceCheckpoint = Omit<WorkspaceCheckpoint, "files">;

function checkpointRoot(workspaceDir: string): string {
  return path.join(workspaceDir, CHECKPOINT_DIR);
}

function indexPath(workspaceDir: string): string {
  return path.join(checkpointRoot(workspaceDir), INDEX_FILE);
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function publicCheckpoint(checkpoint: WorkspaceCheckpoint): PublicWorkspaceCheckpoint {
  const { files: _files, ...metadata } = checkpoint;
  return metadata;
}

function readIndex(workspaceDir: string): WorkspaceCheckpoint[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(workspaceDir), "utf-8"));
    return Array.isArray(parsed) ? parsed.filter(isCheckpoint) : [];
  } catch {
    return [];
  }
}

function isCheckpoint(value: unknown): value is WorkspaceCheckpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkspaceCheckpoint>;
  return (
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    typeof item.createdAt === "number" &&
    typeof item.fileCount === "number" &&
    typeof item.totalBytes === "number" &&
    Array.isArray(item.files) &&
    item.files.every((entry) => typeof entry === "string")
  );
}

function writeIndex(workspaceDir: string, checkpoints: WorkspaceCheckpoint[]): void {
  const root = checkpointRoot(workspaceDir);
  fs.mkdirSync(root, { recursive: true });
  const target = indexPath(workspaceDir);
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(checkpoints, null, 2), "utf-8");
  fs.renameSync(temporary, target);
}

function walkWorkspace(workspaceDir: string): Array<{ relative: string; absolute: string; size: number }> {
  const files: Array<{ relative: string; absolute: string; size: number }> = [];
  const visit = (directory: string, prefix = "") => {
    if (files.length >= MAX_FILES) throw new Error(`Checkpoint exceeds ${MAX_FILES} files`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelative(prefix ? path.join(prefix, entry.name) : entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = fs.statSync(absolute).size;
      if (size > MAX_FILE_BYTES) continue;
      files.push({ relative, absolute, size });
      if (files.length > MAX_FILES) throw new Error(`Checkpoint exceeds ${MAX_FILES} files`);
    }
  };
  visit(workspaceDir);
  return files;
}

function pruneRetention(
  workspaceDir: string,
  checkpoints: WorkspaceCheckpoint[],
  protectedIds: Set<string> = new Set()
): WorkspaceCheckpoint[] {
  const effectiveProtectedIds = new Set(protectedIds);
  const protectedRunIds = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.kind === "run" &&
      checkpoint.runId &&
      protectedRunIds.size < 4 &&
      !protectedRunIds.has(checkpoint.runId)
    ) {
      protectedRunIds.add(checkpoint.runId);
      effectiveProtectedIds.add(checkpoint.id);
    }
  }
  const retained: WorkspaceCheckpoint[] = [];
  const stale: WorkspaceCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    if (retained.length < MAX_CHECKPOINTS || effectiveProtectedIds.has(checkpoint.id)) {
      retained.push(checkpoint);
    } else {
      stale.push(checkpoint);
    }
  }
  while (retained.length > MAX_CHECKPOINTS) {
    let removableIndex = -1;
    for (let index = retained.length - 1; index > 0; index -= 1) {
      if (!effectiveProtectedIds.has(retained[index].id)) {
        removableIndex = index;
        break;
      }
    }
    if (removableIndex < 0) break;
    stale.push(...retained.splice(removableIndex, 1));
  }
  for (const checkpoint of stale) {
    const staleDir = path.join(checkpointRoot(workspaceDir), checkpoint.id);
    fs.rmSync(staleDir, { recursive: true, force: true });
  }
  return retained;
}

export function listCheckpoints(workspaceDir: string): PublicWorkspaceCheckpoint[] {
  return readIndex(workspaceDir)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(publicCheckpoint);
}

export function createCheckpoint(
  workspaceDir: string,
  input: {
    label?: string;
    conversationId?: string;
    runId?: string;
    kind?: WorkspaceCheckpoint["kind"];
    toolCallId?: string;
    retainId?: string;
  } = {}
): PublicWorkspaceCheckpoint {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const files = walkWorkspace(workspaceDir);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`Checkpoint exceeds ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB`);
  }

  const createdAt = Date.now();
  const id = `${createdAt}-${crypto.randomBytes(4).toString("hex")}`;
  const snapshotRoot = path.join(checkpointRoot(workspaceDir), id, "files");
  fs.mkdirSync(snapshotRoot, { recursive: true });

  try {
    for (const file of files) {
      const target = path.join(snapshotRoot, ...file.relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.absolute, target);
    }
  } catch (error) {
    fs.rmSync(path.join(checkpointRoot(workspaceDir), id), { recursive: true, force: true });
    throw error;
  }

  const checkpoint: WorkspaceCheckpoint = {
    id,
    label: input.label?.trim().slice(0, 160) || "Workspace checkpoint",
    createdAt,
    ...(input.conversationId?.trim() ? { conversationId: input.conversationId.trim() } : {}),
    ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.toolCallId?.trim() ? { toolCallId: input.toolCallId.trim() } : {}),
    fileCount: files.length,
    totalBytes,
    files: files.map((file) => file.relative),
  };
  const protectedIds = input.retainId ? new Set([input.retainId]) : undefined;
  const next = pruneRetention(
    workspaceDir,
    [checkpoint, ...readIndex(workspaceDir)],
    protectedIds
  );
  writeIndex(workspaceDir, next);
  return publicCheckpoint(checkpoint);
}

export function restoreCheckpoint(
  workspaceDir: string,
  checkpointId: string
): PublicWorkspaceCheckpoint {
  if (!/^\d+-[a-f0-9]{8}$/.test(checkpointId)) throw new Error("Invalid checkpoint id");
  let checkpoint = readIndex(workspaceDir).find((entry) => entry.id === checkpointId);
  if (!checkpoint) throw new Error("Checkpoint not found");
  createCheckpoint(workspaceDir, {
    label: `Before restore · ${checkpoint.label}`,
    conversationId: checkpoint.conversationId,
    runId: checkpoint.runId,
    kind: "revert",
    retainId: checkpointId,
  });
  checkpoint = readIndex(workspaceDir).find((entry) => entry.id === checkpointId);
  if (!checkpoint) throw new Error("Checkpoint not found");
  const snapshotRoot = path.join(checkpointRoot(workspaceDir), checkpoint.id, "files");
  if (!fs.existsSync(snapshotRoot)) throw new Error("Checkpoint files are missing");

  const captured = new Set(checkpoint.files);
  for (const current of walkWorkspace(workspaceDir)) {
    if (!captured.has(current.relative)) fs.unlinkSync(current.absolute);
  }
  for (const relative of checkpoint.files) {
    const source = path.join(snapshotRoot, ...relative.split("/"));
    if (!fs.existsSync(source)) throw new Error(`Checkpoint file is missing: ${relative}`);
    const target = path.join(workspaceDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.checkpoint-${process.pid}`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, target);
  }
  return publicCheckpoint(checkpoint);
}

export function findCheckpointForRun(
  workspaceDir: string,
  runId: string
): PublicWorkspaceCheckpoint | undefined {
  const normalized = runId.trim();
  if (!normalized) return undefined;
  const matching = readIndex(workspaceDir).filter((entry) => entry.runId === normalized);
  const checkpoint = matching
    .filter((entry) => entry.kind === "run")
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  const legacy = matching
    .filter((entry) => !entry.kind && entry.label.startsWith("Before agent task"))
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  return checkpoint || legacy ? publicCheckpoint(checkpoint || legacy) : undefined;
}
