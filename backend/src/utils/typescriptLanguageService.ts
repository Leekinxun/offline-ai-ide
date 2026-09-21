import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { rgPath } from "@vscode/ripgrep";
import { evaluateContextPath, readAuthorizedWorkspaceFile } from "../agent/contextPolicy.js";

export interface SemanticRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SemanticLocation {
  path: string;
  selection: SemanticRange;
}

interface ScriptFile {
  fileName: string;
  relativePath: string;
  content: string;
  mtimeMs: number;
}

interface ScriptCandidate {
  fileName: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
}

interface SemanticProgram {
  root: string;
  fingerprint: string;
  files: Map<string, ScriptFile>;
  service: ts.LanguageService;
  lastUsedAt: number;
}

export interface TypeScriptSemanticMetrics {
  workspace: string;
  status: "cold" | "ready";
  lookups: number;
  cacheHits: number;
  cacheMisses: number;
  definitions: number;
  references: number;
  indexedFiles: number;
  lastBuildMs?: number;
  totalBuildMs: number;
  lastLookupMs?: number;
}

const SCRIPT_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const MAX_SCRIPT_FILES = 20_000;
const MAX_CACHED_PROGRAMS = 4;
const programCache = new Map<string, SemanticProgram>();
const semanticMetrics = new Map<string, Omit<TypeScriptSemanticMetrics, "workspace" | "status">>();

const compilerOptions: ts.CompilerOptions = {
  allowJs: true,
  allowNonTsExtensions: true,
  checkJs: false,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2020,
  baseUrl: ".",
};

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function scriptKind(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js": case ".mjs": case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function collectScriptMetadata(workspaceDir: string): { root: string; files: Map<string, ScriptCandidate>; fingerprint: string } | null {
  let root: string;
  try { root = fs.realpathSync.native(path.resolve(workspaceDir)); } catch { return null; }
  const files = new Map<string, ScriptCandidate>();
  let listedPaths: string[];
  try {
    const output = execFileSync(rgPath, [
      "--files", "--hidden", "--null",
      "--glob=!.git", "--glob=!.history", "--glob=!.checkpoints",
      "--glob=!node_modules", "--glob=!dist", "--glob=!build", "--glob=!coverage",
      "--glob=!out", "--glob=!target", "--glob=!venv", "--glob=!.venv",
    ], { cwd: root, encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    listedPaths = output.toString("utf8").split("\0").filter(Boolean).sort();
  } catch {
    // The bundled ripgrep is expected in production. An empty result fails
    // closed instead of silently indexing files ignored by workspace policy.
    listedPaths = [];
  }
  for (const relativePath of listedPaths) {
    if (files.size >= MAX_SCRIPT_FILES) break;
    const extension = path.extname(relativePath).toLowerCase();
    if (!SCRIPT_EXTENSIONS.has(extension) || !evaluateContextPath(relativePath).allowed) continue;
    try {
      const absolutePath = path.resolve(root, relativePath);
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      files.set(absolutePath, { fileName: absolutePath, relativePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // An unreadable file is invisible to the semantic host.
    }
  }

  const fingerprint = [...files.values()]
    .map((file) => `${file.relativePath}:${file.mtimeMs}:${file.size}`)
    .join("\n");
  return { root, files, fingerprint };
}

function createProgram(snapshot: { root: string; files: Map<string, ScriptFile>; fingerprint: string }): SemanticProgram {
  const fileNames = [...snapshot.files.keys()];
  const defaultLib = ts.getDefaultLibFilePath(compilerOptions);
  const typescriptLibRoot = path.dirname(defaultLib);
  const isAllowedLib = (fileName: string): boolean => {
    const resolved = path.resolve(fileName);
    return resolved === defaultLib || isContained(typescriptLibRoot, resolved);
  };
  const fileExists = (fileName: string): boolean => snapshot.files.has(path.resolve(fileName)) || isAllowedLib(fileName);
  const readFile = (fileName: string): string | undefined => {
    const resolved = path.resolve(fileName);
    return snapshot.files.get(resolved)?.content ?? (isAllowedLib(resolved) ? ts.sys.readFile(resolved) : undefined);
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({ ...compilerOptions, baseUrl: snapshot.root }),
    getCurrentDirectory: () => snapshot.root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFileName(options),
    getScriptFileNames: () => fileNames,
    getScriptKind: (fileName) => scriptKind(fileName),
    getScriptSnapshot: (fileName) => {
      const content = readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getScriptVersion: (fileName) => String(snapshot.files.get(path.resolve(fileName))?.mtimeMs || 0),
    fileExists,
    readFile,
    readDirectory: (directory, extensions, excludes, includes, depth) =>
      ts.sys.readDirectory(directory, extensions, excludes, includes, depth)
        .filter((fileName) => snapshot.files.has(path.resolve(fileName))),
    directoryExists: (directory) => {
      const resolved = path.resolve(directory);
      return resolved === snapshot.root || [...snapshot.files.keys()].some((fileName) => fileName.startsWith(`${resolved}${path.sep}`));
    },
    getNewLine: () => "\n",
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { ...snapshot, service, lastUsedAt: Date.now() };
}

function getProgram(workspaceDir: string): SemanticProgram | null {
  const metadata = collectScriptMetadata(workspaceDir);
  if (!metadata) return null;
  const current = semanticMetrics.get(metadata.root) || {
    lookups: 0, cacheHits: 0, cacheMisses: 0, definitions: 0, references: 0,
    indexedFiles: 0, totalBuildMs: 0,
  };
  const cached = programCache.get(metadata.root);
  if (cached?.fingerprint === metadata.fingerprint) {
    current.cacheHits += 1;
    semanticMetrics.set(metadata.root, current);
    cached.lastUsedAt = Date.now();
    return cached;
  }
  current.cacheMisses += 1;
  const buildStarted = Date.now();
  const files = new Map<string, ScriptFile>();
  for (const candidate of metadata.files.values()) {
    try {
      const file = readAuthorizedWorkspaceFile(metadata.root, candidate.relativePath);
      files.set(candidate.fileName, {
        fileName: candidate.fileName,
        relativePath: file.path,
        content: file.content,
        mtimeMs: file.mtimeMs,
      });
    } catch {
      // An unreadable, generated, binary, or protected file is invisible to the semantic host.
    }
  }
  const program = createProgram({ root: metadata.root, files, fingerprint: metadata.fingerprint });
  programCache.set(metadata.root, program);
  current.indexedFiles = files.size;
  current.lastBuildMs = Date.now() - buildStarted;
  current.totalBuildMs += current.lastBuildMs;
  semanticMetrics.set(metadata.root, current);
  while (programCache.size > MAX_CACHED_PROGRAMS) {
    const oldest = [...programCache.values()].sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!oldest) break;
    programCache.delete(oldest.root);
  }
  return program;
}

export function warmTypeScriptLanguageService(workspaceDir: string): void {
  try { getProgram(workspaceDir); } catch { /* warm-up is best effort */ }
}

export function getTypeScriptLanguageServiceMetrics(workspaceDir: string): TypeScriptSemanticMetrics {
  let root: string;
  try { root = fs.realpathSync.native(path.resolve(workspaceDir)); } catch { root = path.resolve(workspaceDir); }
  const metrics = semanticMetrics.get(root) || {
    lookups: 0, cacheHits: 0, cacheMisses: 0, definitions: 0, references: 0,
    indexedFiles: 0, totalBuildMs: 0,
  };
  return { workspace: root, status: programCache.has(root) ? "ready" : "cold", ...metrics };
}

function rangeForTextSpan(sourceFile: ts.SourceFile, textSpan: ts.TextSpan): SemanticRange {
  const start = sourceFile.getLineAndCharacterOfPosition(textSpan.start);
  const end = sourceFile.getLineAndCharacterOfPosition(textSpan.start + textSpan.length);
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function toLocation(program: SemanticProgram, fileName: string, textSpan: ts.TextSpan): SemanticLocation | null {
  const resolved = path.resolve(fileName);
  const file = program.files.get(resolved);
  if (!file || !isContained(program.root, resolved)) return null;
  const sourceFile = ts.createSourceFile(file.fileName, file.content, ts.ScriptTarget.Latest, true, scriptKind(file.fileName));
  return { path: file.relativePath, selection: rangeForTextSpan(sourceFile, textSpan) };
}

function identifierPositions(content: string, symbol: string): number[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return [];
  const expression = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}\\b`, "g");
  return [...content.matchAll(expression)].map((match) => match.index || 0);
}

function preferredLocations(program: SemanticProgram, currentPath: string, positions: number[], lookup: (position: number) => readonly ts.DefinitionInfo[] | undefined): SemanticLocation | null {
  const currentFileName = path.resolve(program.root, currentPath);
  const currentRelative = path.relative(program.root, currentFileName).split(path.sep).join("/");
  const locations: SemanticLocation[] = [];
  for (const position of positions) {
    for (const definition of lookup(position) || []) {
      if (path.resolve(definition.fileName) === currentFileName && definition.kind === "alias") continue;
      const location = toLocation(program, definition.fileName, definition.textSpan);
      if (location && !locations.some((entry) => entry.path === location.path && entry.selection.startLine === location.selection.startLine && entry.selection.startColumn === location.selection.startColumn)) {
        locations.push(location);
      }
    }
  }
  return locations.sort((left, right) => Number(left.path === currentRelative) - Number(right.path === currentRelative) || left.path.localeCompare(right.path))[0] || null;
}

export function findTypeScriptDefinition(workspaceDir: string, currentPath: string | undefined, symbol: string): SemanticLocation | null {
  if (!currentPath) return null;
  const lookupStarted = Date.now();
  const program = getProgram(workspaceDir);
  if (!program) return null;
  const metrics = semanticMetrics.get(program.root)!;
  metrics.lookups += 1;
  metrics.definitions += 1;
  metrics.lastLookupMs = Date.now() - lookupStarted;
  semanticMetrics.set(program.root, metrics);
  const currentFileName = path.resolve(program.root, currentPath);
  const current = program.files.get(currentFileName);
  if (!current) return null;
  const positions = identifierPositions(current.content, symbol);
  return preferredLocations(program, current.relativePath, positions, (position) => program.service.getDefinitionAtPosition(current.fileName, position));
}

export function findTypeScriptReferences(workspaceDir: string, currentPath: string | undefined, symbol: string): SemanticLocation[] {
  if (!currentPath) return [];
  const lookupStarted = Date.now();
  const program = getProgram(workspaceDir);
  if (!program) return [];
  const metrics = semanticMetrics.get(program.root)!;
  metrics.lookups += 1;
  metrics.references += 1;
  metrics.lastLookupMs = Date.now() - lookupStarted;
  semanticMetrics.set(program.root, metrics);
  const currentFileName = path.resolve(program.root, currentPath);
  const current = program.files.get(currentFileName);
  if (!current) return [];
  for (const position of identifierPositions(current.content, symbol)) {
    const groups = program.service.findReferences(current.fileName, position) || [];
    const locations = groups.flatMap((group) => group.references.flatMap((reference) => {
      const location = toLocation(program, reference.fileName, reference.textSpan);
      return location ? [location] : [];
    }));
    if (locations.length) {
      return locations.filter((location, index, all) => all.findIndex((entry) => entry.path === location.path && entry.selection.startLine === location.selection.startLine && entry.selection.startColumn === location.selection.startColumn) === index);
    }
  }
  return [];
}
