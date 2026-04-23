import fs from "fs";
import path from "path";

export interface FileSelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface DefinitionLocation {
  path: string;
  selection: FileSelectionRange;
}

interface ImportTarget {
  path: string;
  exportedSymbol?: string;
  isDefault?: boolean;
}

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".nuxt",
  ".vscode",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
  ".venv",
]);

const SEARCHABLE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".cts",
  ".cxx",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

const MODULE_RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".vue",
  ".svelte",
  ".json",
  ".py",
];

function normalizeWorkspacePath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolveWorkspaceRelative(workspaceDir: string, relPath: string): string | null {
  const normalized = normalizeWorkspacePath(relPath);
  const root = path.resolve(workspaceDir);
  const fullPath = path.resolve(root, normalized);
  if (fullPath === root || fullPath.startsWith(`${root}${path.sep}`)) {
    return fullPath;
  }
  return null;
}

function getLanguageFromPath(relPath: string): string {
  switch (path.extname(relPath).toLowerCase()) {
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".kt":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".php":
      return "php";
    case ".rb":
      return "ruby";
    default:
      return "javascript";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDefinitionMatchers(symbol: string, language: string): RegExp[] {
  const escaped = escapeRegExp(symbol);
  const baseMatchers = [
    new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`
    ),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:class|interface|type|enum)\\s+${escaped}\\b`
    ),
    new RegExp(
      `^\\s*(?:(?:public|private|protected|internal|static|readonly|override|abstract|async|open|sealed|virtual|partial|final|synchronized|native)\\s+)*(?:[A-Za-z_][\\w<>,?.\\[\\]\\s]*\\s+)?${escaped}\\s*\\(`
    ),
  ];

  switch (language) {
    case "python":
      return [
        new RegExp(`^\\s*(?:async\\s+def|def|class)\\s+${escaped}\\b`),
        new RegExp(`^\\s*${escaped}\\s*=\\s*`),
      ];
    case "go":
      return [
        new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\b`),
        new RegExp(`^\\s*type\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:var|const)\\s+${escaped}\\b`),
      ];
    case "rust":
      return [
        new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:pub\\s+)?(?:struct|enum|trait|type|mod)\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:pub\\s+)?(?:const|static|let)\\s+${escaped}\\b`),
      ];
    case "java":
    case "kotlin":
    case "swift":
    case "c":
    case "cpp":
    case "csharp":
    case "php":
    case "ruby":
      return [
        new RegExp(`^\\s*(?:class|interface|enum|struct|trait|protocol)\\s+${escaped}\\b`),
        new RegExp(
          `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|open|sealed|partial|fun|func|def)\\s+)*(?:[A-Za-z_][\\w<>,?.\\[\\]\\s]*\\s+)?${escaped}\\s*\\(`
        ),
        new RegExp(`^\\s*(?:const|let|var|val)\\s+${escaped}\\b`),
      ];
    default:
      return baseMatchers;
  }
}

function findDefinitionInContent(
  content: string,
  language: string,
  symbol: string
): FileSelectionRange | null {
  const lines = content.split(/\r?\n/);
  const matchers = buildDefinitionMatchers(symbol, language);

  for (const matcher of matchers) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!matcher.test(line)) continue;

      const startColumn = line.indexOf(symbol) + 1;
      if (startColumn <= 0) continue;

      return {
        startLine: index + 1,
        startColumn,
        endLine: index + 1,
        endColumn: startColumn + symbol.length,
      };
    }
  }

  return null;
}

function findDefaultExportInContent(content: string): FileSelectionRange | null {
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*export\s+default\b/.test(line)) continue;

    const namedMatch = line.match(
      /^\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/
    );
    if (namedMatch) {
      const startColumn = line.indexOf(namedMatch[1]) + 1;
      return {
        startLine: index + 1,
        startColumn,
        endLine: index + 1,
        endColumn: startColumn + namedMatch[1].length,
      };
    }

    const defaultIndex = line.indexOf("default");
    return {
      startLine: index + 1,
      startColumn: defaultIndex + 1,
      endLine: index + 1,
      endColumn: defaultIndex + 8,
    };
  }

  return null;
}

function firstMeaningfulSelection(content: string): FileSelectionRange {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const startColumn = line.search(/\S/);
    if (startColumn < 0) continue;
    return {
      startLine: index + 1,
      startColumn: startColumn + 1,
      endLine: index + 1,
      endColumn: startColumn + 2,
    };
  }

  return { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
}

function pickSelectionForImportTarget(
  content: string,
  relPath: string,
  importTarget: ImportTarget,
  fallbackSymbol: string
): FileSelectionRange {
  const language = getLanguageFromPath(relPath);
  const searchSymbols = [
    importTarget.exportedSymbol,
    importTarget.isDefault ? undefined : fallbackSymbol,
    fallbackSymbol,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const symbol of searchSymbols) {
    const selection = findDefinitionInContent(content, language, symbol);
    if (selection) return selection;
  }

  const defaultSelection = findDefaultExportInContent(content);
  if (defaultSelection) return defaultSelection;

  return firstMeaningfulSelection(content);
}

function importClauseIncludesSymbol(
  clause: string,
  symbol: string
): { imported?: string; isDefault?: boolean; namespace?: boolean } | null {
  const normalized = clause.replace(/\s+/g, " ").trim().replace(/^type\s+/, "");
  if (!normalized) return null;

  const namespaceMatch = normalized.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (namespaceMatch && namespaceMatch[1] === symbol) {
    return { namespace: true };
  }

  const braceIndex = normalized.indexOf("{");
  if (braceIndex >= 0) {
    const defaultPart = normalized.slice(0, braceIndex).replace(/,\s*$/, "").trim();
    const namedPart = normalized.slice(braceIndex + 1, normalized.lastIndexOf("}"));

    if (defaultPart && defaultPart === symbol) {
      return { isDefault: true };
    }

    for (const rawEntry of namedPart.split(",")) {
      const entry = rawEntry.trim().replace(/^type\s+/, "");
      if (!entry) continue;
      const aliasMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) {
        if (aliasMatch[1] === symbol || aliasMatch[2] === symbol) {
          return { imported: aliasMatch[1] };
        }
        continue;
      }
      if (entry === symbol) {
        return { imported: entry };
      }
    }

    return null;
  }

  if (normalized === symbol) {
    return { isDefault: true };
  }

  return null;
}

function resolveModulePath(
  workspaceDir: string,
  currentPath: string,
  specifier: string
): string | null {
  let baseRelPath: string | null = null;
  const currentDir = path.posix.dirname(normalizeWorkspacePath(currentPath));

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    baseRelPath = path.posix.normalize(path.posix.join(currentDir, specifier));
  } else if (specifier.startsWith("@/")) {
    baseRelPath = specifier.slice(2);
  } else if (specifier.startsWith("/")) {
    baseRelPath = specifier.replace(/^\/+/, "");
  } else if (specifier.includes("/")) {
    baseRelPath = specifier;
  } else {
    return null;
  }

  const extension = path.extname(specifier);
  const candidates = extension
    ? [baseRelPath]
    : [
        ...MODULE_RESOLUTION_EXTENSIONS.map((ext) => `${baseRelPath}${ext}`),
        ...MODULE_RESOLUTION_EXTENSIONS.map((ext) => `${baseRelPath}/index${ext}`),
      ];

  for (const candidate of candidates) {
    const fullPath = resolveWorkspaceRelative(workspaceDir, candidate);
    if (fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return normalizeWorkspacePath(candidate);
    }
  }

  return null;
}

function findJavaScriptImportTarget(
  workspaceDir: string,
  currentPath: string,
  content: string,
  symbol: string
): ImportTarget | null {
  const importRegex = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(importRegex)) {
    const clause = match[1]?.trim();
    const source = match[2]?.trim();
    if (!clause || !source) continue;

    const matched = importClauseIncludesSymbol(clause, symbol);
    if (!matched) continue;

    const targetPath = resolveModulePath(workspaceDir, currentPath, source);
    if (!targetPath) continue;

    return {
      path: targetPath,
      exportedSymbol: matched.imported,
      isDefault: Boolean(matched.isDefault),
    };
  }

  const requireRegex =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(requireRegex)) {
    const alias = match[1];
    const source = match[2];
    if (alias !== symbol || !source) continue;

    const targetPath = resolveModulePath(workspaceDir, currentPath, source);
    if (!targetPath) continue;

    return { path: targetPath, isDefault: true };
  }

  return null;
}

function resolvePythonModulePath(
  workspaceDir: string,
  currentPath: string,
  specifier: string
): string | null {
  const match = specifier.match(/^(\.*)(.*)$/);
  if (!match) return null;

  const dots = match[1].length;
  const modulePart = match[2].replace(/\./g, "/");
  const currentDir = path.posix.dirname(normalizeWorkspacePath(currentPath));
  const currentSegments =
    currentDir === "." ? [] : currentDir.split("/").filter(Boolean);

  const baseSegments =
    dots > 0
      ? currentSegments.slice(0, Math.max(currentSegments.length - (dots - 1), 0))
      : [];

  const baseRelPath = path.posix.join(...baseSegments, modulePart);
  const candidates = [
    modulePart ? `${baseRelPath}.py` : "",
    baseRelPath ? `${baseRelPath}/__init__.py` : "__init__.py",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const fullPath = resolveWorkspaceRelative(workspaceDir, candidate);
    if (fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return normalizeWorkspacePath(candidate);
    }
  }

  return null;
}

function parsePythonImportEntry(entry: string): { imported: string; alias: string } | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const aliasMatch = trimmed.match(/^([A-Za-z_][\w]*)\s+as\s+([A-Za-z_][\w]*)$/);
  if (aliasMatch) {
    return { imported: aliasMatch[1], alias: aliasMatch[2] };
  }

  return { imported: trimmed, alias: trimmed };
}

function findPythonImportTarget(
  workspaceDir: string,
  currentPath: string,
  content: string,
  symbol: string
): ImportTarget | null {
  const fromImportRegex = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/gm;
  for (const match of content.matchAll(fromImportRegex)) {
    const moduleSource = match[1];
    const importList = match[2]?.replace(/[()]/g, "") || "";
    const entries = importList.split(",");
    for (const entry of entries) {
      const parsed = parsePythonImportEntry(entry);
      if (!parsed || parsed.alias !== symbol) continue;

      const targetPath = resolvePythonModulePath(workspaceDir, currentPath, moduleSource);
      if (!targetPath) continue;

      return { path: targetPath, exportedSymbol: parsed.imported };
    }
  }

  const importRegex = /^\s*import\s+(.+)$/gm;
  for (const match of content.matchAll(importRegex)) {
    const importList = match[1] || "";
    for (const rawEntry of importList.split(",")) {
      const trimmed = rawEntry.trim();
      if (!trimmed) continue;

      const aliasMatch = trimmed.match(/^([.\w]+)\s+as\s+([A-Za-z_][\w]*)$/);
      const moduleSource = aliasMatch ? aliasMatch[1] : trimmed;
      const alias = aliasMatch ? aliasMatch[2] : moduleSource.split(".").pop() || moduleSource;
      if (alias !== symbol) continue;

      const targetPath = resolvePythonModulePath(workspaceDir, currentPath, moduleSource);
      if (!targetPath) continue;

      return { path: targetPath };
    }
  }

  return null;
}

function findImportedDefinition(
  workspaceDir: string,
  currentPath: string,
  symbol: string
): DefinitionLocation | null {
  const currentFullPath = resolveWorkspaceRelative(workspaceDir, currentPath);
  if (!currentFullPath || !fs.existsSync(currentFullPath) || !fs.statSync(currentFullPath).isFile()) {
    return null;
  }

  let currentContent: string;
  try {
    currentContent = fs.readFileSync(currentFullPath, "utf-8");
  } catch {
    return null;
  }

  const currentLanguage = getLanguageFromPath(currentPath);
  const importTarget =
    currentLanguage === "python"
      ? findPythonImportTarget(workspaceDir, currentPath, currentContent, symbol)
      : findJavaScriptImportTarget(workspaceDir, currentPath, currentContent, symbol);

  if (!importTarget) return null;

  const targetFullPath = resolveWorkspaceRelative(workspaceDir, importTarget.path);
  if (!targetFullPath || !fs.existsSync(targetFullPath) || !fs.statSync(targetFullPath).isFile()) {
    return null;
  }

  let targetContent: string;
  try {
    targetContent = fs.readFileSync(targetFullPath, "utf-8");
  } catch {
    return null;
  }

  return {
    path: importTarget.path,
    selection: pickSelectionForImportTarget(
      targetContent,
      importTarget.path,
      importTarget,
      symbol
    ),
  };
}

function scoreDefinitionMatch(
  relPath: string,
  selection: FileSelectionRange,
  currentPath?: string
): number {
  let score = 0;
  const normalizedCurrent = currentPath ? normalizeWorkspacePath(currentPath) : null;

  if (normalizedCurrent) {
    const currentDir = path.posix.dirname(normalizedCurrent);
    const candidateDir = path.posix.dirname(relPath);
    if (candidateDir === currentDir) score += 50;
    if (relPath.startsWith(`${currentDir}/`)) score += 25;
    if (path.extname(relPath) === path.extname(normalizedCurrent)) score += 10;
  }

  score -= selection.startLine / 100;
  return score;
}

function walkWorkspaceFiles(
  workspaceDir: string,
  relDir: string,
  visit: (relPath: string) => void
): void {
  const fullDir = resolveWorkspaceRelative(workspaceDir, relDir);
  if (!fullDir) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const nextRelDir = relDir
        ? path.posix.join(relDir, entry.name)
        : entry.name;
      walkWorkspaceFiles(workspaceDir, nextRelDir, visit);
      continue;
    }

    const relPath = relDir ? path.posix.join(relDir, entry.name) : entry.name;
    if (!SEARCHABLE_EXTENSIONS.has(path.extname(relPath).toLowerCase())) continue;
    visit(relPath);
  }
}

function findFileNameFallback(
  workspaceDir: string,
  symbol: string,
  currentPath?: string
): DefinitionLocation | null {
  let bestMatch: { location: DefinitionLocation; score: number } | null = null;

  walkWorkspaceFiles(workspaceDir, "", (relPath) => {
    const baseName = path.basename(relPath, path.extname(relPath));
    if (baseName !== symbol) return;

    const fullPath = resolveWorkspaceRelative(workspaceDir, relPath);
    if (!fullPath) return;

    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      return;
    }

    const location = {
      path: relPath,
      selection:
        findDefaultExportInContent(content) ||
        findDefinitionInContent(content, getLanguageFromPath(relPath), symbol) ||
        firstMeaningfulSelection(content),
    };
    const score = scoreDefinitionMatch(relPath, location.selection, currentPath) + 15;

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { location, score };
    }
  });

  const resolvedBestMatch = bestMatch as { location: DefinitionLocation; score: number } | null;
  if (resolvedBestMatch) {
    return resolvedBestMatch.location;
  }

  return null;
}

export function findDefinitionInWorkspace(
  workspaceDir: string,
  symbol: string,
  currentPath?: string
): DefinitionLocation | null {
  const normalizedSymbol = symbol.trim();
  if (!normalizedSymbol) return null;

  const normalizedCurrentPath = currentPath
    ? normalizeWorkspacePath(currentPath)
    : undefined;

  if (normalizedCurrentPath) {
    const importedDefinition = findImportedDefinition(
      workspaceDir,
      normalizedCurrentPath,
      normalizedSymbol
    );
    if (importedDefinition) {
      return importedDefinition;
    }
  }

  let bestMatch: { location: DefinitionLocation; score: number } | null = null;

  walkWorkspaceFiles(workspaceDir, "", (relPath) => {
    if (relPath === normalizedCurrentPath) return;

    const fullPath = resolveWorkspaceRelative(workspaceDir, relPath);
    if (!fullPath) return;

    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      return;
    }

    if (!content.includes(normalizedSymbol)) return;

    const selection = findDefinitionInContent(
      content,
      getLanguageFromPath(relPath),
      normalizedSymbol
    );
    if (!selection) return;

    const score = scoreDefinitionMatch(relPath, selection, normalizedCurrentPath);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        location: { path: relPath, selection },
        score,
      };
    }
  });

  const resolvedBestMatch = bestMatch as { location: DefinitionLocation; score: number } | null;
  if (resolvedBestMatch) {
    return resolvedBestMatch.location;
  }

  return findFileNameFallback(workspaceDir, normalizedSymbol, normalizedCurrentPath);
}
