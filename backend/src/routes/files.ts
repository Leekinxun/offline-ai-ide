import { Router, Request } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { execFileSync } from "child_process";
import { safePath as safePathUtil } from "../utils/safePath.js";
import { findDefinitionInWorkspace } from "../utils/definitionSearch.js";
import { createDirectoryZipStream } from "../utils/zipStream.js";
import type { UserSession } from "../auth/sessionManager.js";
import {
  canWriteActiveWorkspace,
  getTeamManager,
  resolveActiveTeam,
} from "../team/sessionBridge.js";
import { pushTeamSnapshot } from "../ws/team.js";
import {
  buildFileVersion,
  lookupKnownFileMutation,
  recordKnownFileMutation,
} from "../files/mutationRegistry.js";
import { config } from "../config.js";
import { readGitStatus, toRepositoryRelativePath } from "../files/gitStatus.js";
import { CopyEntryError, copyWorkspaceEntry } from "../files/copyEntry.js";

export const filesRouter = Router();

const MAX_DIFF_SOURCE_BYTES = 2 * 1024 * 1024;

interface DiffSource {
  content: string;
  binary: boolean;
  tooLarge: boolean;
}

function decodeDiffSource(buffer: Buffer): DiffSource {
  if (buffer.byteLength > MAX_DIFF_SOURCE_BYTES) {
    return { content: "", binary: false, tooLarge: true };
  }
  if (buffer.includes(0)) {
    return { content: "", binary: true, tooLarge: false };
  }
  return { content: buffer.toString("utf-8"), binary: false, tooLarge: false };
}

function readWorkspaceDiffSource(fullPath: string): DiffSource {
  if (!fs.existsSync(fullPath)) {
    return { content: "", binary: false, tooLarge: false };
  }
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    return { content: fs.readlinkSync(fullPath), binary: false, tooLarge: false };
  }
  if (!stat.isFile()) return { content: "", binary: false, tooLarge: false };
  return decodeDiffSource(fs.readFileSync(fullPath));
}

function readHeadDiffSource(workspaceDir: string, relPath: string): DiffSource {
  try {
    const repositoryPath = toRepositoryRelativePath(workspaceDir, relPath);
    const sizeText = execFileSync("git", ["cat-file", "-s", `HEAD:${repositoryPath}`], {
      cwd: workspaceDir,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (Number(sizeText) > MAX_DIFF_SOURCE_BYTES) {
      return { content: "", binary: false, tooLarge: true };
    }
    const content = execFileSync("git", ["show", `HEAD:${repositoryPath}`], {
      cwd: workspaceDir,
      encoding: "buffer",
      timeout: 10_000,
      maxBuffer: MAX_DIFF_SOURCE_BYTES + 1,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return decodeDiffSource(content);
  } catch {
    return { content: "", binary: false, tooLarge: false };
  }
}

function createUploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.uploadMaxFileSizeMb * 1024 * 1024,
      files: 2000,
    },
  });
}

function getWorkspace(req: Request): string {
  return ((req as any).userSession as UserSession).workspaceDir;
}

function requireWorkspaceWrite(req: Request, res: any): boolean {
  const session = (req as any).userSession as UserSession;
  if (canWriteActiveWorkspace(session)) {
    return true;
  }
  res.status(403).json({ detail: "Active team role is read-only" });
  return false;
}

function maybeRecordTeamActivity(
  req: Request,
  input: {
    type:
      | "file_saved"
      | "entry_created"
      | "entry_deleted"
      | "entry_renamed"
      | "entry_copied";
    payload: Record<string, unknown>;
  }
): void {
  const session = (req as any).userSession as UserSession;
  const team = resolveActiveTeam(session);
  if (!team) {
    return;
  }
  getTeamManager(session).appendActivity(team.id, {
    type: input.type,
    username: session.username,
    payload: input.payload,
  });
  pushTeamSnapshot(session, team.id);
}

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

function normalizeUploadPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0)
    .join("/");

  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }

  return normalized;
}

function getFormFieldValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function joinUploadTarget(targetPath: unknown, filePath: unknown): string | null {
  const fileRelPath = normalizeUploadPath(filePath);
  if (!fileRelPath) {
    return null;
  }

  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return fileRelPath;
  }

  const targetRelPath = normalizeUploadPath(targetPath);
  if (!targetRelPath) {
    return null;
  }

  return `${targetRelPath}/${fileRelPath}`;
}

function buildTree(dirPath: string, relPrefix = ""): FileNode[] {
  const entries: FileNode[] = [];
  let items: string[];
  try {
    items = fs.readdirSync(dirPath);
  } catch {
    return entries;
  }

  // Sort: directories first, then alphabetical
  items.sort((a, b) => {
    const aPath = path.join(dirPath, a);
    const bPath = path.join(dirPath, b);
    const aIsDir = fs.statSync(aPath).isDirectory();
    const bIsDir = fs.statSync(bPath).isDirectory();
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });

  for (const name of items) {
    if (name.startsWith(".")) continue;
    const full = path.join(dirPath, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    try {
      if (fs.statSync(full).isDirectory()) {
        entries.push({ name, path: rel, type: "directory", children: buildTree(full, rel) });
      } else {
        entries.push({ name, path: rel, type: "file" });
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function getDownloadName(relPath: string, isDirectory: boolean): string {
  const baseName = path.basename(relPath) || "download";
  return isDirectory ? `${baseName}.zip` : baseName;
}

function buildAttachmentHeader(filename: string): string {
  const asciiFallback =
    filename
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .trim() || "download";
  const encoded = encodeURIComponent(filename)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function getTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildConflictSourcePayload(
  req: Request,
  relPath: string,
  options?: {
    version?: string;
    updatedAt?: number;
    preferredActor?: string | null;
  }
): {
  source: "team_member" | "external" | "assistant_tool" | "unknown";
  actor?: string;
} {
  const session = (req as any).userSession as UserSession;
  const activeTeam = resolveActiveTeam(session);
  const preferredActor = options?.preferredActor?.trim();

  if (preferredActor && preferredActor !== session.username) {
    return {
      source: "team_member",
      actor: preferredActor,
    };
  }

  const knownMutation = lookupKnownFileMutation(session.workspaceDir, relPath, {
    version: options?.version,
    mtimeMs: options?.updatedAt,
  });
  if (knownMutation?.source === "assistant_tool") {
    return {
      source: "assistant_tool",
      ...(knownMutation.actor ? { actor: knownMutation.actor } : {}),
    };
  }

  if (!activeTeam) {
    return { source: "external" };
  }

  const activeClaim = activeTeam.claims.find(
    (claim) => claim.path === relPath && claim.username !== session.username
  );
  if (activeClaim) {
    return {
      source: "team_member",
      actor: activeClaim.username,
    };
  }

  const activePresence = activeTeam.presence.find(
    (entry) =>
      entry.online &&
      entry.username !== session.username &&
      entry.activeFilePath === relPath
  );
  if (activePresence) {
    return {
      source: "team_member",
      actor: activePresence.username,
    };
  }

  const activityActor = activeTeam.activity.find((entry) => {
    const payloadPath =
      entry.payload && typeof entry.payload.path === "string"
        ? entry.payload.path
        : undefined;
    return (
      entry.type === "file_saved" &&
      entry.username !== session.username &&
      payloadPath === relPath &&
      (typeof options?.updatedAt !== "number" ||
        Math.abs(entry.createdAt - options.updatedAt) < 10_000)
    );
  });
  if (activityActor) {
    return {
      source: "team_member",
      actor: activityActor.username,
    };
  }

  const hasOtherOnlineMembers = activeTeam.presence.some(
    (entry) => entry.online && entry.username !== session.username
  );
  if (hasOtherOnlineMembers) {
    return { source: "unknown" };
  }

  return { source: "external" };
}

// GET /tree
filesRouter.get("/tree", (req, res) => {
  const workspaceDir = getWorkspace(req);
  try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch { /* ignore */ }
  if (!fs.existsSync(workspaceDir)) {
    return res.json([]);
  }
  res.json(buildTree(workspaceDir));
});

// GET /git-status
// Uses fixed git arguments so the UI can inspect repository state without
// exposing a general-purpose command execution endpoint.
filesRouter.get("/git-status", (req, res) => {
  const workspaceDir = getWorkspace(req);
  try {
    return res.json(readGitStatus(workspaceDir));
  } catch {
    return res.json({
      isRepo: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
      updatedAt: Date.now(),
    });
  }
});

// GET /git-diff?path=relative/file
filesRouter.get("/git-diff", (req, res) => {
  const relPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!relPath) return res.status(400).json({ detail: "path required" });

  const workspaceDir = getWorkspace(req);
  try {
    const fullPath = safePathUtil(relPath, workspaceDir);
    const runDiff = (args: string[]): string => {
      try {
        return execFileSync("git", args, {
          cwd: workspaceDir,
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error: any) {
        return String(error?.stdout || "");
      }
    };

    let diff = runDiff(["diff", "HEAD", "--no-ext-diff", "--unified=40", "--", relPath]);
    if (!diff && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      diff = runDiff(["diff", "--no-index", "--unified=40", "/dev/null", fullPath]);
      diff = diff.replaceAll(fullPath, relPath);
    }

    const original = readHeadDiffSource(workspaceDir, relPath);
    const modified = readWorkspaceDiffSource(fullPath);

    return res.json({
      path: relPath,
      diff,
      hasChanges: Boolean(diff.trim()),
      original: original.content,
      modified: modified.content,
      isBinary: original.binary || modified.binary,
      isTooLarge: original.tooLarge || modified.tooLarge,
      updatedAt: Date.now(),
    });
  } catch (error: any) {
    return res.status(error?.message === "Path traversal denied" ? 403 : 400).json({
      detail: error?.message || "Failed to load git diff",
    });
  }
});

// GET /search?query=xxx
// Bounded text search for the command palette. Hidden folders and very large/binary
// files are skipped so this stays responsive in a browser-based IDE.
filesRouter.get("/search", (req, res) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  if (!query) return res.json({ results: [] });

  const workspaceDir = getWorkspace(req);
  const results: Array<{
    path: string;
    line: number;
    column: number;
    preview: string;
  }> = [];
  const normalizedQuery = query.toLocaleLowerCase();
  let visitedFiles = 0;

  const visit = (directory: string, relativePrefix = "") => {
    if (results.length >= 200 || visitedFiles >= 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= 200 || entry.name.startsWith(".")) return;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }

      visitedFiles += 1;
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.size > 1024 * 1024) continue;
        const content = fs.readFileSync(absolutePath, "utf-8");
        if (content.includes("\u0000")) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < 200; index += 1) {
          const line = lines[index];
          const column = line.toLocaleLowerCase().indexOf(normalizedQuery);
          if (column < 0) continue;
          results.push({
            path: relativePath,
            line: index + 1,
            column: column + 1,
            preview: line.trim().slice(0, 240),
          });
        }
      } catch {
        // Ignore files that disappear or cannot be decoded during a search.
      }
    }
  };

  visit(workspaceDir);
  res.json({ results });
});

// GET /changes?since=timestamp
filesRouter.get("/changes", (req, res) => {
  const workspaceDir = getWorkspace(req);
  const since = getTimestamp(req.query.since);

  if (since === null) {
    return res.status(400).json({ detail: "since required" });
  }

  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
  } catch {
    // ignore
  }

  if (!fs.existsSync(workspaceDir)) {
    return res.json({ changed: false, latestMtime: since });
  }

  let latestMtime = 0;
  let changed = false;

  const visit = (fullPath: string) => {
    if (changed) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(fullPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const absolutePath = path.join(fullPath, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        continue;
      }

      latestMtime = Math.max(latestMtime, stat.mtimeMs);
      if (stat.mtimeMs > since) {
        changed = true;
        return;
      }

      if (entry.isDirectory()) {
        visit(absolutePath);
        if (changed) {
          return;
        }
      }
    }
  };

  const rootStat = fs.statSync(workspaceDir);
  latestMtime = Math.max(latestMtime, rootStat.mtimeMs);
  changed = rootStat.mtimeMs > since;

  if (!changed) {
    visit(workspaceDir);
  }

  return res.json({
    changed,
    latestMtime: Math.max(latestMtime, since),
  });
});

// GET /read?path=xxx
filesRouter.get("/read", (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ detail: "path required" });
  try {
    const full = safePathUtil(relPath, getWorkspace(req));
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return res.status(404).json({ detail: "File not found" });
    }
    const stat = fs.statSync(full);
    const content = fs.readFileSync(full, "utf-8");
    const version = buildFileVersion(content);
    const sourceInfo = lookupKnownFileMutation(getWorkspace(req), relPath, {
      version,
      mtimeMs: stat.mtimeMs,
    });
    res.json({
      path: relPath,
      content,
      version,
      updatedAt: stat.mtimeMs,
      ...(sourceInfo
        ? {
            source:
              sourceInfo.source === "assistant_tool"
                ? "assistant_tool"
                : sourceInfo.source,
            ...(sourceInfo.actor ? { actor: sourceInfo.actor } : {}),
          }
        : {}),
    });
  } catch (e: any) {
    res.status(e.message === "Path traversal denied" ? 403 : 500).json({ detail: e.message });
  }
});

// GET /definition?symbol=xxx&currentPath=yyy
filesRouter.get("/definition", (req, res) => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";
  const currentPath =
    typeof req.query.currentPath === "string" ? req.query.currentPath.trim() : undefined;

  if (!symbol) return res.status(400).json({ detail: "symbol required" });

  try {
    const location = findDefinitionInWorkspace(getWorkspace(req), symbol, currentPath);
    if (!location) {
      return res.status(404).json({ detail: "Definition not found" });
    }
    return res.json(location);
  } catch (e: any) {
    return res.status(500).json({ detail: e.message });
  }
});

// GET /download?path=xxx
filesRouter.get("/download", (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ detail: "path required" });

  try {
    const fullPath = safePathUtil(relPath, getWorkspace(req));
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ detail: "Not found" });
    }

    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      return res.status(400).json({ detail: "Symbolic links are not supported" });
    }

    if (stat.isFile()) {
      return res.download(fullPath, getDownloadName(relPath, false), (error) => {
        if (!error || res.headersSent) return;
        res.status(500).json({ detail: error.message });
      });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ detail: "Unsupported file type" });
    }

    const archiveName = getDownloadName(relPath, true);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", buildAttachmentHeader(archiveName));

    const archiveRoot = path.basename(relPath) || "download";
    const zipStream = createDirectoryZipStream(fullPath, archiveRoot);

    zipStream.on("error", (error) => {
      if (!res.headersSent) {
        res.status(500).json({ detail: error.message });
        return;
      }
      res.destroy(error);
    });

    return zipStream.pipe(res);
  } catch (e: any) {
    res.status(e.message === "Path traversal denied" ? 403 : 500).json({ detail: e.message });
  }
});

// POST /write  { path, content }
filesRouter.post("/write", (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const { path: relPath, content, force, expectedVersion } = req.body;
  if (!relPath) return res.status(400).json({ detail: "path required" });
  try {
    const session = (req as any).userSession as UserSession;
    const team = resolveActiveTeam(session);
    if (team) {
      const existingClaim = team.claims.find((claim) => claim.path === relPath);
      if (existingClaim && existingClaim.username !== session.username && !force) {
        return res.status(409).json({
          detail: "File is claimed by another member",
          code: "TEAM_CLAIM_CONFLICT",
          claim: existingClaim,
        });
      }
    }
    const full = safePathUtil(relPath, getWorkspace(req));
    const existedBeforeWrite = fs.existsSync(full);
    const currentContent =
      existedBeforeWrite && fs.statSync(full).isFile()
        ? fs.readFileSync(full, "utf-8")
        : "";
    const currentVersion = buildFileVersion(currentContent);
    if (
      existedBeforeWrite &&
      !force &&
      (typeof expectedVersion !== "string" || !expectedVersion || currentVersion !== expectedVersion)
    ) {
      const conflictSource = buildConflictSourcePayload(req, relPath, {
        version: currentVersion,
        updatedAt: fs.statSync(full).mtimeMs,
      });
      return res.status(409).json({
        detail: "File changed since last load",
        code: "FILE_VERSION_CONFLICT",
        current: {
          content: currentContent,
          version: currentVersion,
          updatedAt: fs.statSync(full).mtimeMs,
          source: conflictSource.source,
          ...(conflictSource.actor ? { actor: conflictSource.actor } : {}),
        },
      });
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    const nextVersion = buildFileVersion(content);
    const stat = fs.statSync(full);
    recordKnownFileMutation({
      workspaceDir: getWorkspace(req),
      path: relPath,
      source: "user",
      actor: session.username,
      mtimeMs: stat.mtimeMs,
      version: nextVersion,
    });
    maybeRecordTeamActivity(req, {
      type: "file_saved",
      payload: {
        path: relPath,
        source: "user",
        forced: Boolean(force),
        claimOwner:
          team?.claims.find((claim) => claim.path === relPath && claim.username !== session.username)
            ?.username || null,
      },
    });
    res.json({
      status: "ok",
      version: nextVersion,
      updatedAt: stat.mtimeMs,
    });
  } catch (e: any) {
    res.status(500).json({ detail: e.message });
  }
});

// POST /create  { path, is_directory }
filesRouter.post("/create", (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const { path: relPath, is_directory } = req.body;
  if (!relPath) return res.status(400).json({ detail: "path required" });
  try {
    const full = safePathUtil(relPath, getWorkspace(req));
    if (fs.existsSync(full)) {
      return res.status(409).json({ detail: "Already exists" });
    }
    if (is_directory) {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "", "utf-8");
    }
    maybeRecordTeamActivity(req, {
      type: "entry_created",
      payload: {
        path: relPath,
        isDirectory: Boolean(is_directory),
      },
    });
    res.json({ status: "ok" });
  } catch (e: any) {
    res.status(500).json({ detail: e.message });
  }
});

// POST /copy  { source_path, target_directory }
filesRouter.post("/copy", (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const sourcePath = typeof req.body?.source_path === "string" ? req.body.source_path : "";
  const targetDirectory =
    typeof req.body?.target_directory === "string" ? req.body.target_directory : "";

  try {
    const result = copyWorkspaceEntry(getWorkspace(req), sourcePath, targetDirectory);
    maybeRecordTeamActivity(req, {
      type: "entry_copied",
      payload: {
        sourcePath: result.sourcePath,
        path: result.path,
        isDirectory: result.type === "directory",
      },
    });
    return res.json({ status: "ok", ...result });
  } catch (error) {
    if (error instanceof CopyEntryError) {
      return res.status(error.status).json({ detail: error.message, code: error.code });
    }
    const message = error instanceof Error ? error.message : "Copy failed";
    return res
      .status(message === "Path traversal denied" ? 403 : 500)
      .json({ detail: message });
  }
});

// POST /upload multipart/form-data { targetPath, overwrite, files[], paths[] }
filesRouter.post("/upload", (req, res, next) => {
  if (!requireWorkspaceWrite(req, res)) return;

  createUploadMiddleware().array("files")(req, res, (error) => {
    if (error) {
      const message =
        error instanceof multer.MulterError
          ? error.message
          : error instanceof Error
          ? error.message
          : "Upload failed";
      return res.status(400).json({ detail: message });
    }
    next();
  });
}, (req, res) => {
  const { targetPath } = req.body;
  const overwrite =
    req.body.overwrite === true ||
    req.body.overwrite === "true" ||
    req.body.overwrite === "1";
  const files = Array.isArray(req.files)
    ? (req.files as Express.Multer.File[])
    : [];
  const requestedPaths = getFormFieldValues(req.body.paths);

  if (files.length === 0) {
    return res.status(400).json({ detail: "files required" });
  }

  try {
    const session = (req as any).userSession as UserSession;
    const workspaceDir = getWorkspace(req);
    const prepared = files.map((file, index) => {
      const relPath = joinUploadTarget(
        targetPath,
        requestedPaths[index] || file.originalname
      );
      if (!relPath) {
        throw new Error("Invalid upload path");
      }

      return {
        relPath,
        fullPath: safePathUtil(relPath, workspaceDir),
        content: file.buffer,
      };
    });

    const conflicts = prepared
      .filter((file) => fs.existsSync(file.fullPath))
      .map((file) => file.relPath);

    if (conflicts.length > 0 && !overwrite) {
      return res.status(409).json({
        detail: "Upload target already exists",
        code: "UPLOAD_CONFLICT",
        conflicts,
      });
    }

    fs.mkdirSync(workspaceDir, { recursive: true });
    for (const file of prepared) {
      fs.mkdirSync(path.dirname(file.fullPath), { recursive: true });
      fs.writeFileSync(file.fullPath, file.content);

      const stat = fs.statSync(file.fullPath);
      recordKnownFileMutation({
        workspaceDir,
        path: file.relPath,
        source: "user",
        actor: session.username,
        mtimeMs: stat.mtimeMs,
        version: buildFileVersion(file.content.toString("base64")),
      });
    }

    maybeRecordTeamActivity(req, {
      type: "entry_created",
      payload: {
        path: typeof targetPath === "string" && targetPath.trim() ? targetPath.trim() : "",
        uploadedCount: prepared.length,
        overwrittenCount: conflicts.length,
      },
    });

    res.json({
      status: "ok",
      uploaded: prepared.length,
      overwritten: conflicts.length,
    });
  } catch (e: any) {
    const status = e.message === "Path traversal denied" ? 403 : 500;
    res.status(status).json({ detail: e.message });
  }
});

// DELETE /delete?path=xxx
filesRouter.delete("/delete", (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ detail: "path required" });
  try {
    const full = safePathUtil(relPath, getWorkspace(req));
    if (!fs.existsSync(full)) {
      return res.status(404).json({ detail: "Not found" });
    }
    fs.rmSync(full, { recursive: true, force: true });
    maybeRecordTeamActivity(req, {
      type: "entry_deleted",
      payload: {
        path: relPath,
      },
    });
    res.json({ status: "ok" });
  } catch (e: any) {
    res.status(500).json({ detail: e.message });
  }
});

// POST /rename  { old_path, new_path }
filesRouter.post("/rename", (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const { old_path, new_path } = req.body;
  if (!old_path || !new_path) return res.status(400).json({ detail: "paths required" });
  try {
    const wsDir = getWorkspace(req);
    const oldFull = safePathUtil(old_path, wsDir);
    const newFull = safePathUtil(new_path, wsDir);
    if (!fs.existsSync(oldFull)) {
      return res.status(404).json({ detail: "Source not found" });
    }
    if (fs.existsSync(newFull)) {
      return res.status(409).json({ detail: "Target already exists" });
    }
    fs.mkdirSync(path.dirname(newFull), { recursive: true });
    fs.renameSync(oldFull, newFull);
    maybeRecordTeamActivity(req, {
      type: "entry_renamed",
      payload: {
        oldPath: old_path,
        newPath: new_path,
      },
    });
    res.json({ status: "ok" });
  } catch (e: any) {
    res.status(500).json({ detail: e.message });
  }
});
