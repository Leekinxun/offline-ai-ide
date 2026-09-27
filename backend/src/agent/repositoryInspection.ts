import fs from "node:fs";
import path from "node:path";
import { safePath } from "../utils/safePath.js";
import { searchWorkspace } from "../files/workspaceSearch.js";
import {
  evaluateContextPath,
  readAuthorizedWorkspaceFile,
} from "./contextPolicy.js";
import type { OpenAIToolDef } from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_JSON_CHARS = 50_000;

export const REPOSITORY_INSPECTION_TOOLS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find authorized workspace files by glob without reading generated, protected, secret, or symlinked content.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: { type: "string", description: "Glob pattern, for example **/*.ts or src/**/*.test.ts" },
          path: { type: "string", description: "Optional workspace-relative directory scope; defaults to ." },
          max_results: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search authorized workspace file contents. Results follow the same secret/generated/protected policy as read_file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1 },
          path: { type: "string", description: "Optional workspace-relative directory scope; defaults to ." },
          regex: { type: "boolean", description: "Treat query as a regular expression" },
          max_results: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List authorized immediate children of a workspace directory, excluding generated, protected, secret, and symlinked entries.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative directory path; defaults to ." },
          max_results: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
      },
    },
  },
];

type EntryType = "file" | "directory";

interface DirectoryEntry {
  path: string;
  type: EntryType;
  size?: number;
}

function limit(value: unknown): number {
  const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(parsed, MAX_LIMIT));
}

function normalizeToolPath(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : ".";
  const normalized = raw.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return normalized || ".";
}

function displayPath(scope: string, name?: string): string {
  const joined = name ? path.posix.join(scope === "." ? "" : scope, name) : scope;
  return joined.replace(/^\.$/, "").replace(/^\//, "") || ".";
}

function ensureDirectory(workspaceDir: string, relativePath: string): string {
  const fullPath = safePath(relativePath, workspaceDir);
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) throw new Error("Path escapes workspace through a symbolic link");
  if (!stat.isDirectory()) throw new Error("Path is not a directory");
  if (relativePath !== ".") {
    const policy = evaluateContextPath(relativePath);
    if (!policy.allowed) throw new Error(`Path is not authorized: ${policy.reason || "invalid_path"}`);
  }
  return fullPath;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation cancelled");
}

function isAuthorizedFile(workspaceDir: string, relativePath: string): boolean {
  try {
    readAuthorizedWorkspaceFile(workspaceDir, relativePath);
    return true;
  } catch {
    return false;
  }
}

function isAuthorizedDirectory(relativePath: string): boolean {
  if (relativePath === ".") return true;
  return evaluateContextPath(relativePath).allowed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  const value = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "*") {
      const next = value[i + 1];
      if (next === "*") {
        const after = value[i + 2];
        if (after === "/") {
          source += "(?:.*\\/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const close = value.indexOf("}", i + 1);
      if (close > i) {
        const alternatives = value.slice(i + 1, close).split(",").map(escapeRegExp);
        source += `(?:${alternatives.join("|")})`;
        i = close;
      } else {
        source += "\\{";
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

function encodeBoundedJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= MAX_JSON_CHARS) return json;
  return `${json.slice(0, MAX_JSON_CHARS)}\n... truncated`;
}

async function findFiles(
  args: Record<string, unknown>,
  workspaceDir: string,
  signal?: AbortSignal
): Promise<string> {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) throw new Error("find_files requires a non-empty pattern");
  const scope = normalizeToolPath(args.path);
  const fullScope = ensureDirectory(workspaceDir, scope);
  const maxResults = limit(args.max_results);
  const matcher = globToRegExp(pattern);
  const results: string[] = [];
  let truncated = false;

  const visit = (fullDir: string, relativeDir: string): void => {
    throwIfAborted(signal);
    const entries = fs.readdirSync(fullDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      const relative = displayPath(relativeDir, entry.name);
      const full = path.join(fullDir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isAuthorizedDirectory(relative)) visit(full, relative);
        continue;
      }
      if (!entry.isFile() || !matcher.test(relative) || !isAuthorizedFile(workspaceDir, relative)) continue;
      results.push(relative);
    }
  };

  visit(fullScope, scope);
  return encodeBoundedJson({ results, truncated });
}

async function searchFiles(
  args: Record<string, unknown>,
  workspaceDir: string,
  signal?: AbortSignal
): Promise<string> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) throw new Error("search_files requires a non-empty query");
  const scope = normalizeToolPath(args.path);
  ensureDirectory(workspaceDir, scope);
  const maxResults = limit(args.max_results);
  const response = await searchWorkspace({
    workspaceDir,
    query,
    scopePath: scope === "." ? undefined : scope,
    isRegex: args.regex === true,
    maxResults,
    signal,
  });
  const results = response.results
    .filter((result) => isAuthorizedFile(workspaceDir, result.path))
    .slice(0, maxResults);
  return encodeBoundedJson({
    results,
    truncated: response.truncated || results.length >= maxResults,
  });
}

async function listDirectory(
  args: Record<string, unknown>,
  workspaceDir: string,
  signal?: AbortSignal
): Promise<string> {
  const scope = normalizeToolPath(args.path);
  const fullScope = ensureDirectory(workspaceDir, scope);
  const maxResults = limit(args.max_results);
  const entries: DirectoryEntry[] = [];
  let truncated = false;

  for (const entry of fs.readdirSync(fullScope, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal);
    if (entries.length >= maxResults) {
      truncated = true;
      break;
    }
    const relative = displayPath(scope, entry.name);
    const full = path.join(fullScope, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (isAuthorizedDirectory(relative)) entries.push({ path: relative, type: "directory" });
      continue;
    }
    if (entry.isFile() && isAuthorizedFile(workspaceDir, relative)) {
      entries.push({ path: relative, type: "file", size: stat.size });
    }
  }

  return encodeBoundedJson({ entries, truncated });
}

export async function executeRepositoryInspectionTool(
  name: string,
  args: Record<string, unknown>,
  workspaceDir: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    if (name === "find_files") return await findFiles(args, workspaceDir, signal);
    if (name === "search_files") return await searchFiles(args, workspaceDir, signal);
    if (name === "list_directory") return await listDirectory(args, workspaceDir, signal);
    return `Error: Unknown repository inspection tool: ${name}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
