import { Router } from "express";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { safePath as safePathUtil } from "../utils/safePath.js";

export const filesRouter = Router();

function safePath(rel: string): string {
  return safePathUtil(rel, config.workspaceDir);
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

// GET /tree
filesRouter.get("/tree", (_req, res) => {
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  res.json(buildTree(config.workspaceDir));
});

// GET /read?path=xxx
filesRouter.get("/read", (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ detail: "path required" });
  try {
    const full = safePath(relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return res.status(404).json({ detail: "File not found" });
    }
    const content = fs.readFileSync(full, "utf-8");
    res.json({ path: relPath, content });
  } catch (e: any) {
    res.status(e.message === "Path traversal denied" ? 403 : 500).json({ detail: e.message });
  }
});

// POST /write  { path, content }
filesRouter.post("/write", (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath) return res.status(400).json({ detail: "path required" });
  try {
    const full = safePath(relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    res.json({ status: "ok" });
  } catch (e: any) {
    res.status(500).json({ detail: e.message });
  }
});

// POST /create  { path, is_directory }
filesRouter.post("/create", (req, res) => {
  const { path: relPath, is_directory } = req.body;
  if (!relPath) return res.status(400).json({ detail: "path required" });
  try {
    const full = safePath(relPath);
    if (fs.existsSync(full)) {
      return res.status(409).json({ detail: "Already exists" });
    }
    if (is_directory) {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "", "utf-8");
    }
    res.json({ status: "ok" });
  } catch (e: any) {
    res.status(500).json({ detail: e.message });
  }
});

// DELETE /delete?path=xxx
filesRouter.delete("/delete", (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ detail: "path required" });
  try {
    const full = safePath(relPath);
    if (!fs.existsSync(full)) {
      return res.status(404).json({ detail: "Not found" });
    }
    fs.rmSync(full, { recursive: true, force: true });
    res.json({ status: "ok" });
  } catch (e: any) {
    res.status(500).json({ detail: e.message });
  }
});

// POST /rename  { old_path, new_path }
filesRouter.post("/rename", (req, res) => {
  const { old_path, new_path } = req.body;
  if (!old_path || !new_path) return res.status(400).json({ detail: "paths required" });
  try {
    const oldFull = safePath(old_path);
    const newFull = safePath(new_path);
    if (!fs.existsSync(oldFull)) {
      return res.status(404).json({ detail: "Source not found" });
    }
    if (fs.existsSync(newFull)) {
      return res.status(409).json({ detail: "Target already exists" });
    }
    fs.mkdirSync(path.dirname(newFull), { recursive: true });
    fs.renameSync(oldFull, newFull);
    res.json({ status: "ok" });
  } catch (e: any) {
    res.status(500).json({ detail: e.message });
  }
});
