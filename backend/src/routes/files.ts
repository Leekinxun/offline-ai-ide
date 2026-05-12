import { Router, Request } from "express";
import fs from "fs";
import path from "path";
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

export const filesRouter = Router();

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
      | "entry_renamed";
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
