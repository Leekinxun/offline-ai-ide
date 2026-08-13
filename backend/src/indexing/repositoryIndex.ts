import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { getDiagnostics } from "../diagnostics/service.js";
import { evaluateContextPath, readAuthorizedWorkspaceFile } from "../agent/contextPolicy.js";
import { searchWorkspace } from "../files/workspaceSearch.js";
import { subscribeWorkspaceMutations } from "../files/mutationRegistry.js";
import { registerContextIndexAdapter, type ContextIndexStatus } from "../agent/contextManifestIndex.js";
import { indexLanguageFile, LANGUAGE_ADAPTER_VERSIONS } from "./languageAdapters.js";
import { RepositoryIndexStore } from "./indexStore.js";
import { resolveRepositoryOwnership } from "./ownershipResolver.js";
import type {
  GitFileSignal,
  IndexedRepositoryFile,
  RepositoryContextCandidate,
  RepositoryDiagnosticSignal,
  RepositoryIndexMeta,
  RepositoryIndexStatus,
  RepositoryMutation,
  RetrieveRepositoryContextOptions,
} from "./types.js";

export type {
  RepositoryContextCandidate,
  RepositoryDiagnosticSignal,
  RepositoryIndexStatus,
  RepositoryMutation,
  RepositoryOwnershipSignal,
  RetrieveRepositoryContextOptions,
} from "./types.js";

const MAX_INDEXED_FILES = 250_000;
const MAX_CONTEXT_SNIPPET_LINES = 80;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:^|\/)(?:test_[^/]+|[^/]+\.(?:test|spec))\.[^/]+$/i;
const QUERY_STOPWORDS = new Set(["a", "an", "and", "as", "at", "by", "change", "definition", "for", "from", "in", "integration", "into", "of", "on", "or", "source", "test", "tests", "the", "through", "to", "unit", "update", "used", "with"]);
const activeRebuilds = new Map<string, Promise<RepositoryIndexStatus>>();
const pendingInvalidations = new Map<string, { mutations: Map<string, RepositoryMutation>; timer: NodeJS.Timeout }>();
const fileCache = new Map<string, { revision: number; files: Map<string, IndexedRepositoryFile> }>();
const headCache = new Map<string, { value?: string; expiresAt: number }>();

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readGitMetadataPointer(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024) return null;
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (!value || value.includes("\0") || /[\r\n]/.test(value)) return null;
    return value;
  } catch { return null; }
}

function isCanonicalLinkedWorktree(workspaceRoot: string, commonRoot: string, gitDir: string): boolean {
  const relativeGitDir = path.relative(commonRoot, gitDir);
  const parts = relativeGitDir.split(path.sep);
  if (parts.length !== 2 || parts[0] !== "worktrees" || !parts[1] || parts[1] === "." || parts[1] === "..") return false;

  const worktreesDir = path.join(commonRoot, "worktrees");
  const workspaceGitFile = path.join(workspaceRoot, ".git");
  try {
    if (fs.lstatSync(worktreesDir).isSymbolicLink() || !fs.lstatSync(worktreesDir).isDirectory()) return false;
    if (fs.lstatSync(gitDir).isSymbolicLink() || !fs.lstatSync(gitDir).isDirectory()) return false;
    if (fs.lstatSync(workspaceGitFile).isSymbolicLink() || !fs.lstatSync(workspaceGitFile).isFile()) return false;
  } catch { return false; }

  const workspacePointer = readGitMetadataPointer(workspaceGitFile);
  if (!workspacePointer?.startsWith("gitdir:")) return false;
  const workspaceTarget = workspacePointer.slice("gitdir:".length).trim();
  if (!workspaceTarget) return false;
  try {
    const resolvedTarget = fs.realpathSync.native(path.resolve(path.dirname(workspaceGitFile), workspaceTarget));
    if (resolvedTarget !== gitDir) return false;
  } catch { return false; }

  const backPointerFile = path.join(gitDir, "gitdir");
  const backPointer = readGitMetadataPointer(backPointerFile);
  if (!backPointer) return false;
  try {
    const resolvedBackPointer = fs.realpathSync.native(path.resolve(path.dirname(backPointerFile), backPointer));
    if (resolvedBackPointer !== fs.realpathSync.native(workspaceGitFile)) return false;
  } catch { return false; }

  const commonPointerFile = path.join(gitDir, "commondir");
  const commonPointer = readGitMetadataPointer(commonPointerFile);
  if (!commonPointer) return false;
  try {
    return fs.realpathSync.native(path.resolve(path.dirname(commonPointerFile), commonPointer)) === commonRoot;
  } catch { return false; }
}

function gitInfoExcludePath(workspaceDir: string): string | null {
  try {
    const options = { cwd: workspaceDir, encoding: "utf8" as const, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    const workspaceRoot = fs.realpathSync.native(workspaceDir);
    const commonText = execFileSync("git", ["-C", workspaceDir, "rev-parse", "--path-format=absolute", "--git-common-dir"], options).trim();
    const gitDirText = execFileSync("git", ["-C", workspaceDir, "rev-parse", "--path-format=absolute", "--git-dir"], options).trim();
    const excludeText = execFileSync("git", ["-C", workspaceDir, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], options).trim();
    if (!commonText || !gitDirText || !excludeText) return null;
    const commonCandidate = path.isAbsolute(commonText) ? commonText : path.resolve(workspaceDir, commonText);
    const gitDirCandidate = path.isAbsolute(gitDirText) ? gitDirText : path.resolve(workspaceDir, gitDirText);
    const commonRoot = fs.realpathSync.native(commonCandidate);
    const gitDir = fs.realpathSync.native(gitDirCandidate);
    if (!fs.lstatSync(commonRoot).isDirectory()) return null;
    if (!isWithin(workspaceRoot, commonRoot) && !isCanonicalLinkedWorktree(workspaceRoot, commonRoot, gitDir)) return null;
    const expected = path.join(commonRoot, "info", "exclude");
    const candidate = path.resolve(path.isAbsolute(excludeText) ? excludeText : path.resolve(workspaceDir, excludeText));
    if (candidate !== expected || !candidate.startsWith(`${commonRoot}${path.sep}`)) return null;
    let cursor = commonRoot;
    for (const segment of ["info", "exclude"]) {
      cursor = path.join(cursor, segment);
      if (!fs.existsSync(cursor)) break;
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    return expected;
  } catch { return null; }
}

function hashBoundedPolicyFile(hash: crypto.Hash, filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) { hash.update("unsafe"); return; }
    if (stat.size <= 1024 * 1024) hash.update(fs.readFileSync(filePath));
    else hash.update(`${stat.size}:${stat.mtimeMs}`);
  } catch { hash.update("missing"); }
}

function ignoreFingerprint(workspaceDir: string): string {
  let output: Buffer;
  try {
    output = execFileSync(rgPath, [
      "--files", "--hidden", "--no-ignore", "--null",
      "--glob=.gitignore", "--glob=**/.gitignore",
      "--glob=.ignore", "--glob=**/.ignore",
      "--glob=.rgignore", "--glob=**/.rgignore",
      "--glob=!.git", "--glob=!.history", "--glob=!.checkpoints", "--glob=!node_modules",
    ], { cwd: workspaceDir, encoding: "buffer", timeout: 10_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch { output = Buffer.alloc(0); }
  const hash = crypto.createHash("sha256");
  for (const filePath of output.toString("utf8").split("\0").filter(Boolean).sort()) {
    const normalized = filePath.replace(/\\/g, "/"); hash.update(normalized).update("\0");
    try {
      const fullPath = path.join(workspaceDir, normalized); const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink() || !stat.isFile()) { hash.update("unsafe"); continue; }
      if (stat.size <= 1024 * 1024) hash.update(fs.readFileSync(fullPath));
      else hash.update(`${stat.size}:${stat.mtimeMs}`);
    } catch { hash.update("unreadable"); }
    hash.update("\0");
  }
  const gitExclude = gitInfoExcludePath(workspaceDir);
  hash.update("git-info-exclude\0");
  if (gitExclude) { hash.update(gitExclude).update("\0"); hashBoundedPolicyFile(hash, gitExclude); }
  else hash.update("unavailable");
  return hash.digest("hex");
}

function filterGitIgnoredPaths(workspaceDir: string, paths: string[]): string[] {
  if (!paths.length || !gitInfoExcludePath(workspaceDir)) return paths;
  const input = Buffer.from(`${paths.join("\0")}\0`);
  let output = Buffer.alloc(0);
  try {
    output = execFileSync("git", ["-C", workspaceDir, "check-ignore", "--no-index", "-z", "--stdin"], {
      input, encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error) {
    const commandError = error as { status?: number | null; stdout?: Buffer | string };
    if (commandError.status !== 1) return [];
    const stdout = commandError.stdout;
    if (stdout) output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }
  const ignored = new Set(output.toString("utf8").split("\0").filter(Boolean).map((value) => value.replace(/\\/g, "/")));
  return ignored.size ? paths.filter((filePath) => !ignored.has(filePath)) : paths;
}

function git(workspaceDir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", workspaceDir, ...args], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch { return null; }
}

function currentHead(workspaceDir: string): string | undefined {
  const key = path.resolve(workspaceDir); const cached = headCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = git(workspaceDir, ["rev-parse", "--verify", "HEAD"]) || undefined;
  headCache.set(key, { value, expiresAt: Date.now() + 1_000 }); return value;
}

function listIndexablePaths(workspaceDir: string, prefix?: string): string[] {
  const args = [
    "--files", "--hidden", "--null",
    "--glob=!.git", "--glob=!.history", "--glob=!.checkpoints", "--glob=!.team",
    "--glob=!.codex", "--glob=!.omx", "--glob=!.crewforge", "--glob=!node_modules",
    "--glob=!dist", "--glob=!build", "--glob=!coverage", "--glob=!target", "--glob=!vendor",
    ...(prefix ? ["--", prefix] : []),
  ];
  let output: Buffer;
  try { output = execFileSync(rgPath, args, { cwd: workspaceDir, encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return []; }
  const paths = output.toString("utf8").split("\0").filter(Boolean).map((value) => value.replace(/\\/g, "/"));
  const authorized = paths.filter((value) => evaluateContextPath(value).allowed);
  return filterGitIgnoredPaths(workspaceDir, authorized).sort().slice(0, MAX_INDEXED_FILES);
}

function readGitSignals(workspaceDir: string): Map<string, GitFileSignal> {
  const result = new Map<string, GitFileSignal>();
  const log = git(workspaceDir, ["-c", "core.quotepath=false", "log", "-n", "50", "--format=@@%H%x09%ct%x09%an", "--name-only"]);
  if (log) {
    let commit: string | undefined; let committedAt: number | undefined; let author: string | undefined;
    for (const line of log.split(/\r?\n/)) {
      if (line.startsWith("@@")) {
        const fields = line.slice(2).split("\t"); commit = fields[0]; committedAt = Number(fields[1]) * 1000; author = fields.slice(2).join("\t"); continue;
      }
      const filePath = line.trim().replace(/\\/g, "/");
      if (!filePath || !evaluateContextPath(filePath).allowed) continue;
      const current = result.get(filePath) || { changeCount: 0 };
      current.changeCount += 1;
      if (!current.commit) Object.assign(current, { commit, committedAt, author });
      result.set(filePath, current);
    }
  }
  const status = git(workspaceDir, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-uall"]);
  for (const entry of status?.split("\0") || []) {
    const filePath = entry.slice(3).split(" -> ").at(-1)?.trim().replace(/\\/g, "/");
    if (!filePath || !evaluateContextPath(filePath).allowed) continue;
    const current = result.get(filePath) || { changeCount: 0 }; current.dirty = true; result.set(filePath, current);
  }
  return result;
}

function resolveImport(importer: string, source: string, knownPaths: Set<string>): string | undefined {
  let base: string;
  if (source.startsWith(".") && path.posix.extname(importer).startsWith(".py")) {
    const dots = source.match(/^\.+/)?.[0].length || 0;
    const moduleName = source.slice(dots).replace(/\./g, "/");
    let directory = path.posix.dirname(importer);
    for (let index = 1; index < dots; index += 1) directory = path.posix.dirname(directory);
    base = path.posix.normalize(path.posix.join(directory, moduleName));
  }
  else if (source.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), source));
  else if (source.startsWith("@/")) base = source.slice(2);
  else if (path.posix.extname(importer).startsWith(".py")) base = source.replace(/\./g, "/");
  else return undefined;
  const pythonBase = base.replace(/\./g, "/");
  const withoutJsExtension = base.replace(/\.(?:mjs|cjs|js|jsx)$/i, "");
  const candidates = [base, pythonBase, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".py"].flatMap((extension) => [`${base}${extension}`, `${withoutJsExtension}${extension}`, `${base}/index${extension}`, `${pythonBase}${extension}`]), `${pythonBase}/__init__.py`];
  return candidates.find((candidate) => knownPaths.has(candidate));
}

function indexOne(workspaceDir: string, filePath: string, gitSignals: Map<string, GitFileSignal>): IndexedRepositoryFile | null {
  try {
    const file = readAuthorizedWorkspaceFile(workspaceDir, filePath);
    const indexed = indexLanguageFile(file.path, file.content);
    return {
      path: file.path, language: indexed.language, size: file.size, mtimeMs: file.mtimeMs,
      contentHash: digest(file.content), indexedAt: Date.now(), generated: file.generated, test: TEST_PATH.test(file.path),
      symbols: indexed.symbols, imports: indexed.imports, references: indexed.references, git: gitSignals.get(file.path),
    };
  } catch { return null; }
}

function meta(store: RepositoryIndexStore, previous: RepositoryIndexMeta | null, fileCount: number, status: RepositoryIndexMeta["status"] = "ready", error?: string, policyFingerprint = ignoreFingerprint(store.workspaceRoot)): RepositoryIndexMeta {
  const now = Date.now();
  return {
    schemaVersion: 1, partitionId: store.partitionId, workspaceRoot: store.workspaceRoot,
    revision: (previous?.revision || 0) + 1, policyVersion: 1, adapterVersions: LANGUAGE_ADAPTER_VERSIONS,
    ignoreFingerprint: policyFingerprint,
    headSha: currentHead(store.workspaceRoot), indexedAt: previous?.indexedAt || now, updatedAt: now,
    fileCount, status, ...(error ? { error } : {}),
  };
}

function publicStatus(store: RepositoryIndexStore, value = store.readMeta()): RepositoryIndexStatus {
  const head = currentHead(store.workspaceRoot);
  const adaptersStale = Boolean(value && Object.entries(LANGUAGE_ADAPTER_VERSIONS).some(([id, version]) => value.adapterVersions[id] !== version));
  const stale = adaptersStale || Boolean(value?.headSha && head && value.headSha !== head);
  return {
    schemaVersion: 1, partitionId: store.partitionId, revision: value?.revision || 0,
    status: !value ? "missing" : stale ? "stale" : value.status, fileCount: value?.fileCount || 0,
    ...(value?.indexedAt ? { indexedAt: value.indexedAt } : {}), ...(value?.updatedAt ? { updatedAt: value.updatedAt } : {}),
    ...(head ? { headSha: head } : {}), semanticMode: "off", ...(value?.error ? { lastError: value.error } : {}),
  };
}

function indexedFiles(store: RepositoryIndexStore, indexMeta: RepositoryIndexMeta): Map<string, IndexedRepositoryFile> {
  const cached = fileCache.get(store.partitionId);
  if (cached?.revision === indexMeta.revision) return cached.files;
  const files = store.readAllFiles(); fileCache.set(store.partitionId, { revision: indexMeta.revision, files }); return files;
}

export function getRepositoryIndexStatus(workspaceDir: string): RepositoryIndexStatus {
  return publicStatus(new RepositoryIndexStore(workspaceDir));
}

/** Synchronous, freshness-checked lookup used by the legacy definition route. */
export function findRepositoryDefinition(
  workspaceDir: string,
  symbol: string,
  currentPath?: string
): { path: string; selection: import("./types.js").RepositoryRange } | null {
  const store = new RepositoryIndexStore(workspaceDir);
  const indexMeta = store.readMeta();
  if (!indexMeta || publicStatus(store, indexMeta).status !== "ready") return null;
  const normalizedSymbol = symbol.trim();
  if (!normalizedSymbol) return null;
  const matches: Array<{ file: IndexedRepositoryFile; symbol: IndexedRepositoryFile["symbols"][number]; score: number }> = [];
  for (const file of indexedFiles(store, indexMeta).values()) {
    for (const indexedSymbol of file.symbols) {
      if (indexedSymbol.name !== normalizedSymbol) continue;
      let score = indexedSymbol.confidence === "exact" ? 100 : 50;
      if (currentPath && path.posix.dirname(file.path) === path.posix.dirname(currentPath.replace(/\\/g, "/"))) score += 25;
      matches.push({ file, symbol: indexedSymbol, score });
    }
  }
  matches.sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  for (const match of matches) {
    try {
      const live = readAuthorizedWorkspaceFile(store.workspaceRoot, match.file.path);
      if (digest(live.content) !== match.file.contentHash) continue;
      return { path: match.file.path, selection: match.symbol.range };
    } catch { /* stale or unauthorized records are ignored */ }
  }
  return null;
}

export async function rebuildRepositoryIndex(workspaceDir: string): Promise<RepositoryIndexStatus> {
  const store = new RepositoryIndexStore(workspaceDir);
  const existing = activeRebuilds.get(store.partitionId);
  if (existing) return existing;
  const running = Promise.resolve().then(() => store.withRebuildLock(() => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let marker!: RepositoryIndexMeta;
      store.withLock(() => { const previous = store.readMeta(); marker = meta(store, previous, previous?.fileCount || 0, "rebuilding"); store.writeMeta(marker); });
      try {
        const buildIgnoreFingerprint = ignoreFingerprint(store.workspaceRoot);
        const paths = listIndexablePaths(store.workspaceRoot);
        if (buildIgnoreFingerprint !== ignoreFingerprint(store.workspaceRoot)) continue;
        const gitSignals = readGitSignals(store.workspaceRoot);
        const files = new Map<string, IndexedRepositoryFile>();
        for (const filePath of paths) {
          const file = indexOne(store.workspaceRoot, filePath, gitSignals);
          if (file) files.set(filePath, file);
        }
        const known = new Set(files.keys());
        for (const file of files.values()) for (const imported of file.imports) imported.resolvedPath = resolveImport(file.path, imported.source, known);
        if (process.env.NODE_ENV === "test") {
          const delay = Number(process.env.CREWFORGE_INDEX_REBUILD_TEST_DELAY_MS || 0);
          if (Number.isFinite(delay) && delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, 5_000));
        }
        if (buildIgnoreFingerprint !== ignoreFingerprint(store.workspaceRoot)) continue;
        const completed = meta(store, marker, files.size, "ready", undefined, buildIgnoreFingerprint);
        if (!store.replaceAllIfRevision(files, completed, marker.revision)) continue;
        fileCache.set(store.partitionId, { revision: completed.revision, files });
        return publicStatus(store, completed);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Repository index rebuild failed";
        store.withLock(() => { const current = store.readMeta(); if (current?.revision === marker.revision) store.writeMeta(meta(store, current, current.fileCount, "error", message)); });
        return publicStatus(store);
      }
    }
    return publicStatus(store);
  })).finally(() => activeRebuilds.delete(store.partitionId));
  activeRebuilds.set(store.partitionId, running);
  return running;
}

export async function invalidateRepositoryIndex(workspaceDir: string, mutations: RepositoryMutation[]): Promise<RepositoryIndexStatus> {
  const store = new RepositoryIndexStore(workspaceDir);
  if (!store.readMeta()) await rebuildRepositoryIndex(store.workspaceRoot);
  if (mutations.some((mutation) => [".gitignore", ".ignore", ".rgignore"].includes(path.posix.basename(mutation.path)))) {
    return rebuildRepositoryIndex(store.workspaceRoot);
  }
  const changes = new Map<string, IndexedRepositoryFile | null>();
  const currentMeta = store.readMeta();
  const policyFingerprint = ignoreFingerprint(store.workspaceRoot);
  if (!currentMeta || currentMeta.ignoreFingerprint !== policyFingerprint) return rebuildRepositoryIndex(store.workspaceRoot);
  const currentFiles = currentMeta ? indexedFiles(store, currentMeta) : new Map<string, IndexedRepositoryFile>();
  const gitSignals = new Map<string, GitFileSignal>();
  const underPrefix = (filePath: string, prefix: string) => filePath === prefix || filePath.startsWith(`${prefix}/`);
  for (const mutation of mutations) {
    const policy = evaluateContextPath(mutation.path);
    const prefixScope = mutation.scope === "prefix";
    if (mutation.operation === "rename" && mutation.previousPath) {
      const previous = evaluateContextPath(mutation.previousPath);
      if (previous.normalizedPath) {
        if (prefixScope) {
          for (const filePath of currentFiles.keys()) if (underPrefix(filePath, previous.normalizedPath)) changes.set(filePath, null);
        } else {
          changes.set(previous.normalizedPath, null);
        }
      }
    }
    if (!policy.normalizedPath) continue;
    if (prefixScope) {
      const prefix = policy.normalizedPath;
      if (mutation.operation === "delete" || !policy.allowed) {
        for (const filePath of currentFiles.keys()) if (underPrefix(filePath, prefix)) changes.set(filePath, null);
        continue;
      }
      const discovered = new Set(listIndexablePaths(store.workspaceRoot, prefix));
      for (const filePath of currentFiles.keys()) if (underPrefix(filePath, prefix) && !discovered.has(filePath)) changes.set(filePath, null);
      for (const filePath of discovered) {
        const previous = currentFiles.get(filePath)?.git;
        gitSignals.set(filePath, { ...(previous || { changeCount: 0 }), dirty: true });
        changes.set(filePath, indexOne(store.workspaceRoot, filePath, gitSignals));
      }
      continue;
    }
    if (mutation.operation === "delete" || !policy.allowed) changes.set(policy.normalizedPath, null);
    else {
      const previous = currentFiles.get(policy.normalizedPath)?.git;
      gitSignals.set(policy.normalizedPath, { ...(previous || { changeCount: 0 }), dirty: true });
      changes.set(policy.normalizedPath, indexOne(store.workspaceRoot, policy.normalizedPath, gitSignals));
    }
  }
  if (changes.size === 0) return publicStatus(store);
  const nextFiles = new Map(currentFiles);
  for (const [filePath, file] of changes) { if (file) nextFiles.set(filePath, file); else nextFiles.delete(filePath); }
  const knownPaths = new Set(nextFiles.keys());
  const topologyChanged = mutations.some((mutation) => mutation.scope === "prefix" || mutation.operation === "create" || mutation.operation === "delete" || mutation.operation === "rename");
  const pathsToResolve = topologyChanged
    ? [...nextFiles.keys()]
    : [...changes.entries()].filter((entry): entry is [string, IndexedRepositoryFile] => Boolean(entry[1])).map(([filePath]) => filePath);
  for (const filePath of pathsToResolve) {
    const file = nextFiles.get(filePath); if (!file?.imports.length) continue;
    let changed = false;
    const imports = file.imports.map((imported) => {
      const resolvedPath = resolveImport(file.path, imported.source, knownPaths);
      if (resolvedPath === imported.resolvedPath) return imported;
      changed = true; return { ...imported, ...(resolvedPath ? { resolvedPath } : { resolvedPath: undefined }) };
    });
    if (!changed) continue;
    const resolvedFile = { ...file, imports, indexedAt: changes.has(filePath) ? file.indexedAt : Date.now() };
    nextFiles.set(filePath, resolvedFile); changes.set(filePath, resolvedFile);
  }
  if (policyFingerprint !== ignoreFingerprint(store.workspaceRoot)) return rebuildRepositoryIndex(store.workspaceRoot);
  const updatedMeta = store.updateFiles(changes, (current, fileCount) => meta(store, current, fileCount, "ready", undefined, policyFingerprint));
  const cacheFiles = updatedMeta.revision === currentMeta.revision + 1 ? nextFiles : store.readAllFiles();
  fileCache.set(store.partitionId, { revision: updatedMeta.revision, files: cacheFiles });
  return publicStatus(store);
}

function queryTerms(query: string): string[] {
  return [...new Set(query.match(/[A-Za-z_$][\w$.-]*/g)?.map((term) => term.toLowerCase()).filter((term) => term.length > 1 && !QUERY_STOPWORDS.has(term)) || [])].slice(0, 30);
}

function excerpt(content: string, line = 1): string {
  const lines = content.split(/\r?\n/); const start = Math.max(0, line - 6); return lines.slice(start, start + MAX_CONTEXT_SNIPPET_LINES).join("\n").slice(0, 16_000);
}

function candidate(file: IndexedRepositoryFile, metaValue: RepositoryIndexMeta, input: Partial<RepositoryContextCandidate> & Pick<RepositoryContextCandidate, "sourceKey" | "kind" | "reasons" | "score">): RepositoryContextCandidate {
  return {
    path: file.path, generated: file.generated, trust: file.generated ? "generated" : "workspace",
    estimatedTokens: 0, freshness: { indexRevision: metaValue.revision, indexedAt: file.indexedAt, verifiedAt: 0, contentHash: file.contentHash },
    ...input,
  };
}

export async function retrieveRepositoryContext(options: RetrieveRepositoryContextOptions): Promise<RepositoryContextCandidate[]> {
  options.signal?.throwIfAborted();
  let status = getRepositoryIndexStatus(options.workspaceDir);
  if (status.status !== "ready") status = await rebuildRepositoryIndex(options.workspaceDir);
  if (status.status !== "ready") return [];
  const store = new RepositoryIndexStore(options.workspaceDir);
  let metaValue = store.readMeta(); if (!metaValue) return [];
  const startingIgnoreFingerprint = ignoreFingerprint(store.workspaceRoot);
  if (metaValue.ignoreFingerprint !== startingIgnoreFingerprint) {
    status = await rebuildRepositoryIndex(store.workspaceRoot);
    if (status.status !== "ready") return [];
    metaValue = store.readMeta(); if (!metaValue || metaValue.ignoreFingerprint !== ignoreFingerprint(store.workspaceRoot)) return [];
  }
  const files = indexedFiles(store, metaValue); const terms = queryTerms(options.query);
  const testIntent = /\b(?:test|tests|testing|spec|specs)\b/i.test(options.query);
  const changedPaths = new Set([...(options.changedPaths || []), ...(options.currentPath ? [options.currentPath] : [])].map((value) => evaluateContextPath(value).normalizedPath).filter((value): value is string => Boolean(value)));
  const excluded = new Set((options.excludedPaths || []).map((value) => evaluateContextPath(value).normalizedPath).filter((value): value is string => Boolean(value)));
  const pinned = new Set((options.pinnedPaths || []).map((value) => evaluateContextPath(value)).filter((value) => value.allowed).map((value) => value.normalizedPath!));
  const candidates = new Map<string, RepositoryContextCandidate>();
  const add = (next: RepositoryContextCandidate) => {
    if (!next.path || excluded.has(next.path)) return;
    const current = candidates.get(next.sourceKey);
    if (!current || next.score > current.score) candidates.set(next.sourceKey, next);
  };

  for (const file of files.values()) {
    if (excluded.has(file.path)) continue;
    const lowerPath = file.path.toLowerCase();
    const pathHits = terms.filter((term) => lowerPath.includes(term));
    if (pathHits.length || pinned.has(file.path)) add(candidate(file, metaValue, { sourceKey: `path:${file.path}`, kind: "path", reasons: pinned.has(file.path) ? ["user pinned authorized path"] : [`path matches ${pathHits.join(", ")}`], score: (pinned.has(file.path) ? 1000 : 80) + pathHits.length * 10 }));
    if (changedPaths.has(file.path)) add(candidate(file, metaValue, { sourceKey: `changed:${file.path}`, kind: "path", reasons: ["current or changed path"], score: 165 }));
    for (const symbol of file.symbols) {
      const hits = terms.filter((term) => symbol.name.toLowerCase().includes(term));
      if (!hits.length) continue;
      const exact = hits.some((term) => symbol.name.toLowerCase() === term);
      add(candidate(file, metaValue, { sourceKey: `definition:${file.path}:${symbol.name}:${symbol.range.startLine}`, kind: "definition", symbol: symbol.name, range: symbol.range, reasons: [`symbol definition matches ${hits.join(", ")}`], score: (file.test ? 150 : 180) + (exact ? 60 : hits.length * 20) }));
    }
    const reference = file.references.find((entry) => terms.includes(entry.symbol.toLowerCase()));
    if (reference) add(candidate(file, metaValue, { sourceKey: `reference:${file.path}:${reference.symbol}:${reference.line}`, kind: "reference", symbol: reference.symbol, range: { startLine: reference.line, startColumn: reference.column, endLine: reference.line, endColumn: reference.column + reference.symbol.length }, reasons: ["file references a query symbol"], score: 110 }));
    const imported = file.imports.find((entry) => terms.some((term) => entry.source.toLowerCase().includes(term) || entry.names.some((name) => name.toLowerCase().includes(term))));
    if (imported) add(candidate(file, metaValue, { sourceKey: `import:${file.path}:${imported.line}`, kind: "import", reasons: ["import relationship matches query"], score: 125 }));
    if (file.test && (pathHits.length || file.references.some((entry) => terms.includes(entry.symbol.toLowerCase())) || file.imports.some((entry) => entry.resolvedPath && options.currentPath === entry.resolvedPath))) add(candidate(file, metaValue, { sourceKey: `test:${file.path}`, kind: "test", reasons: ["related test file"], score: 135 }));
    if (file.git?.dirty && (pathHits.length || file.path === options.currentPath)) add(candidate(file, metaValue, { sourceKey: `git:${file.path}`, kind: "git", reasons: ["recent uncommitted change"], score: 100 }));
  }

  // Expand only from already-authorized lexical/symbol/current-path seeds. This
  // captures callers, aliased imports, and reverse test selection without letting
  // graph expansion bypass path policy or the result budget.
  const seedPaths = new Set([...candidates.values()].map((entry) => entry.path).filter((value): value is string => Boolean(value)));
  for (const file of files.values()) {
    if (excluded.has(file.path)) continue;
    for (const imported of file.imports) {
      if (!imported.resolvedPath) continue;
      const target = files.get(imported.resolvedPath);
      const importMatches = terms.some((term) => imported.names.some((name) => name.toLowerCase() === term || name.toLowerCase().includes(term)));
      if (target && (importMatches || (file.path === options.currentPath && terms.some((term) => file.references.some((reference) => reference.symbol.toLowerCase() === term))))) {
        const definition = target.symbols.find((symbol) => terms.includes(symbol.name.toLowerCase()) || imported.names.includes(symbol.name)) || target.symbols[0];
        add(candidate(target, metaValue, { sourceKey: `graph-target:${target.path}:${file.path}:${imported.line}`, kind: "import", ...(definition ? { symbol: definition.name, range: definition.range } : {}), reasons: [`imported by ${file.path}`], score: 250 }));
        seedPaths.add(target.path);
      }
      if (seedPaths.has(imported.resolvedPath) || changedPaths.has(imported.resolvedPath)) {
        add(candidate(file, metaValue, { sourceKey: `${file.test ? "test" : "graph-caller"}:${file.path}:${imported.resolvedPath}`, kind: file.test ? "test" : "import", reasons: [file.test ? `test imports changed file ${imported.resolvedPath}` : `imports matched file ${imported.resolvedPath}`], score: file.test ? (testIntent ? 320 : 190) : 170 }));
      }
    }
  }

  const lexical = candidates.size === 0
    ? await searchWorkspace({ workspaceDir: store.workspaceRoot, query: options.query, maxResults: Math.min(100, options.maxResults || 20), signal: options.signal }).catch(() => ({ results: [], truncated: false }))
    : { results: [], truncated: false };
  for (const match of lexical.results) {
    const file = files.get(match.path); if (!file) continue;
    add(candidate(file, metaValue, { sourceKey: `lexical:${file.path}:${match.line}:${match.column}`, kind: "lexical", range: { startLine: match.line, startColumn: match.column, endLine: match.line, endColumn: match.column + match.matchLength }, reasons: ["ripgrep lexical match"], score: 145 }));
  }

  const diagnostics: RepositoryDiagnosticSignal[] = options.diagnostics || getDiagnostics(store.workspaceRoot).diagnostics;
  for (const diagnostic of diagnostics) {
    const file = files.get(diagnostic.path); if (!file || excluded.has(file.path)) continue;
    if (terms.length && !terms.some((term) => diagnostic.message.toLowerCase().includes(term) || file.path.toLowerCase().includes(term))) continue;
    add(candidate(file, metaValue, { sourceKey: `diagnostic:${file.path}:${diagnostic.line}:${diagnostic.column}`, kind: "diagnostic", range: { startLine: diagnostic.line, startColumn: diagnostic.column, endLine: diagnostic.line, endColumn: diagnostic.column + 1 }, reasons: [`${diagnostic.severity} diagnostic matches query`], score: diagnostic.severity === "error" ? 170 : 120 }));
  }
  for (const ownership of options.ownership || []) {
    const file = files.get(ownership.path); if (!file || excluded.has(file.path)) continue;
    if (!terms.some((term) => ownership.owner.toLowerCase().includes(term) || file.path.toLowerCase().includes(term)) && file.path !== options.currentPath) continue;
    add(candidate(file, metaValue, { sourceKey: `ownership:${file.path}:${ownership.source}:${ownership.owner}`, kind: "ownership", reasons: [`${ownership.source} owner: ${ownership.owner}`], score: 90 }));
  }

  let ranked = [...candidates.values()].sort((left, right) => right.score - left.score || left.sourceKey.localeCompare(right.sourceKey));
  if (options.semantic?.mode === "local" && options.semantic.rerank) {
    try {
      const order = await options.semantic.rerank(options.query, ranked.map((entry) => ({ ...entry, content: undefined })));
      const positions = new Map(order.map((key, index) => [key, index]));
      ranked = ranked.sort((left, right) => (positions.get(left.sourceKey) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.sourceKey) ?? Number.MAX_SAFE_INTEGER) || right.score - left.score);
    } catch { /* local semantic failure preserves authorized lexical/graph ranking */ }
  }

  const result: RepositoryContextCandidate[] = []; let usedTokens = 0;
  for (const entry of ranked) {
    if (!entry.path || result.length >= Math.max(1, Math.min(options.maxResults || 20, 100))) break;
    try {
      const live = readAuthorizedWorkspaceFile(store.workspaceRoot, entry.path);
      const liveHash = digest(live.content);
      if (liveHash !== entry.freshness.contentHash) continue;
      const snippet = excerpt(live.content, entry.range?.startLine || 1);
      const estimatedTokens = Math.ceil(snippet.length / 4);
      if (result.length && usedTokens + estimatedTokens > Math.max(256, options.maxTokens || 8_000)) continue;
      result.push({ ...entry, content: snippet, contentDigest: digest(snippet), estimatedTokens, freshness: { ...entry.freshness, verifiedAt: Date.now(), contentHash: liveHash } });
      usedTokens += estimatedTokens;
    } catch { /* freshness and policy revalidation are fail closed */ }
  }
  // Ignore rules are mutable workspace policy. A change anywhere during the
  // retrieval invalidates the whole result instead of exposing a stale record.
  if (metaValue.ignoreFingerprint !== ignoreFingerprint(store.workspaceRoot)) return [];
  return result;
}

subscribeWorkspaceMutations((event) => {
  const store = new RepositoryIndexStore(event.workspaceDir);
  const pending = pendingInvalidations.get(store.partitionId) || {
    mutations: new Map<string, RepositoryMutation>(),
    timer: setTimeout(() => undefined, 0),
  };
  clearTimeout(pending.timer);
  const mutation: RepositoryMutation = { path: event.path, operation: event.operation, ...(event.previousPath ? { previousPath: event.previousPath } : {}), ...(event.scope === "prefix" ? { scope: "prefix" as const } : {}) };
  pending.mutations.set(`${mutation.scope || "file"}:${mutation.previousPath || ""}:${event.path}`, mutation);
  pending.timer = setTimeout(() => {
    pendingInvalidations.delete(store.partitionId);
    void invalidateRepositoryIndex(store.workspaceRoot, [...pending.mutations.values()]).catch(() => undefined);
  }, 25);
  pending.timer.unref?.();
  pendingInvalidations.set(store.partitionId, pending);
});

function manifestIndexStatus(status: RepositoryIndexStatus): ContextIndexStatus {
  return {
    status: status.status === "ready" ? "ready" : status.status === "rebuilding" ? "indexing" : status.status === "error" ? "error" : "idle",
    generation: `${status.partitionId}:${status.revision}`,
    indexedFiles: status.fileCount,
    updatedAt: status.updatedAt,
    ...(status.lastError ? { error: status.lastError } : {}),
  };
}

registerContextIndexAdapter({
  status: (workspaceDir) => manifestIndexStatus(getRepositoryIndexStatus(workspaceDir)),
  preview: async (workspaceDir, input) => {
    const candidates = await retrieveRepositoryContext({
      workspaceDir, query: input.query, maxResults: input.limit,
      pinnedPaths: input.preferences.pins.map((pin) => pin.path), excludedPaths: input.preferences.excludes,
    });
    return candidates.map((entry) => ({
      id: entry.sourceKey, path: entry.path, reason: entry.reasons.join("; "), estimatedTokens: entry.estimatedTokens,
      freshness: "fresh" as const, trust: entry.trust, decision: "included" as const, ruleIds: [entry.kind],
    }));
  },
  retrieve: async (workspaceDir, input) => {
    const pinnedPaths = input.preferences.pins.map((pin) => pin.path);
    const relevantPaths = [...new Set([...(input.currentPath ? [input.currentPath] : []), ...(input.changedPaths || []), ...pinnedPaths])];
    const ownership = resolveRepositoryOwnership(workspaceDir, input.viewer, relevantPaths);
    const candidates = await retrieveRepositoryContext({
      workspaceDir, query: input.query, currentPath: input.currentPath, changedPaths: input.changedPaths,
      maxResults: input.maxResults, maxTokens: input.maxTokens, pinnedPaths, excludedPaths: input.preferences.excludes,
      ownership, signal: input.signal,
    });
    const includedPaths = new Set(candidates.map((entry) => entry.path).filter((value): value is string => Boolean(value)));
    const included = candidates.map((entry) => ({
      id: entry.sourceKey, path: entry.path, reason: entry.reasons.join("; "), estimatedTokens: entry.estimatedTokens,
      freshness: "fresh" as const, trust: entry.trust, decision: "included" as const, ruleIds: [entry.kind],
      pinned: Boolean(entry.path && pinnedPaths.includes(entry.path)), content: entry.content, contentDigest: entry.contentDigest,
      sourceUpdatedAt: entry.freshness.verifiedAt || entry.freshness.indexedAt,
    }));
    const excludedPins = input.preferences.pins.filter((pin) => !includedPaths.has(pin.path)).map((pin) => ({
      id: `pin-excluded:${pin.id}`, path: pin.path,
      reason: input.preferences.excludes.includes(pin.path) ? "pinned path excluded by current preference" : "pinned path unavailable, ignored, secret, stale, or outside the active context budget",
      estimatedTokens: 0, freshness: "unknown" as const, trust: "workspace", decision: "excluded" as const,
      ruleIds: ["pin_policy"], pinned: true,
    }));
    return [...included, ...excludedPins];
  },
  refresh: async (workspaceDir, paths) => manifestIndexStatus(paths?.length
    ? await invalidateRepositoryIndex(workspaceDir, paths.map((filePath) => ({ path: filePath, operation: fs.existsSync(path.join(workspaceDir, filePath)) ? "modify" as const : "delete" as const })))
    : await rebuildRepositoryIndex(workspaceDir)),
  rebuild: async (workspaceDir) => manifestIndexStatus(await rebuildRepositoryIndex(workspaceDir)),
});
