import path from "node:path";
import type { IndexedImport, IndexedReference, IndexedSymbol, RepositoryRange } from "./types.js";

export interface LanguageIndexResult {
  language: string;
  adapterId: string;
  adapterVersion: number;
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
  references: IndexedReference[];
}

interface LanguageAdapter {
  id: string;
  version: number;
  extensions: Set<string>;
  index(content: string): Omit<LanguageIndexResult, "language" | "adapterId" | "adapterVersion">;
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "else", "enum",
  "export", "extends", "false", "finally", "for", "from", "function", "if", "import", "in", "interface", "let",
  "new", "null", "of", "pass", "return", "static", "super", "this", "throw", "true", "try", "type", "undefined",
  "var", "while", "with", "yield",
]);
const MAX_REFERENCES_PER_FILE = 512;

function range(line: number, column: number, length: number): RepositoryRange {
  return { startLine: line, startColumn: column, endLine: line, endColumn: column + length };
}

/**
 * Lexical references are only a navigation hint, so retaining every occurrence
 * is both wasteful and actively harmful on generated-looking comment blocks.
 * Blank comments and string literals while preserving newlines/columns, then
 * retain the first code occurrence of each identifier.
 */
function codeOnly(content: string, python = false): string {
  const output = [...content];
  let quote = "";
  let triple = false;
  let blockComment = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1] || "";
    const third = content[index + 2] || "";
    if (blockComment) {
      if (current === "*" && next === "/") { output[index] = output[index + 1] = " "; index += 1; blockComment = false; }
      else if (current !== "\n" && current !== "\r") output[index] = " ";
      continue;
    }
    if (quote) {
      if (triple && current === quote && next === quote && third === quote) {
        output[index] = output[index + 1] = output[index + 2] = " "; index += 2; quote = ""; triple = false; escaped = false;
      } else {
        if (current !== "\n" && current !== "\r") output[index] = " ";
        if (!triple && !escaped && current === quote) quote = "";
        escaped = !escaped && current === "\\";
        if (current !== "\\") escaped = false;
      }
      continue;
    }
    if (!python && current === "/" && next === "*") { output[index] = output[index + 1] = " "; index += 1; blockComment = true; continue; }
    if ((current === "/" && next === "/") || (python && current === "#")) {
      let cursor = index;
      for (; cursor < content.length && content[cursor] !== "\n" && content[cursor] !== "\r"; cursor += 1) output[cursor] = " ";
      index = cursor - 1;
      continue;
    }
    if (current === "'" || current === '"' || (!python && current === "`")) {
      triple = python && next === current && third === current;
      quote = current; output[index] = " ";
      if (triple) { output[index + 1] = output[index + 2] = " "; index += 2; }
    }
  }
  return output.join("");
}

function references(content: string, definitions: Set<string>, python = false): IndexedReference[] {
  const result: IndexedReference[] = [];
  const seen = new Set<string>();
  for (const [index, line] of codeOnly(content, python).split(/\r?\n/).entries()) {
    for (const match of line.matchAll(IDENTIFIER)) {
      const symbol = match[0];
      if (KEYWORDS.has(symbol) || definitions.has(symbol) || seen.has(symbol)) continue;
      result.push({ symbol, line: index + 1, column: (match.index || 0) + 1, confidence: "lexical" });
      seen.add(symbol);
      if (result.length >= MAX_REFERENCES_PER_FILE) return result;
    }
  }
  return result;
}

function jsIndex(content: string) {
  const symbols: IndexedSymbol[] = [];
  const imports: IndexedImport[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const declaration = line.match(/^\s*(export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (declaration) {
      const name = declaration[3];
      const rawKind = declaration[2];
      const kind: IndexedSymbol["kind"] = rawKind === "function" ? "function" : rawKind === "class" ? "class" : ["interface", "type", "enum"].includes(rawKind) ? "type" : "variable";
      symbols.push({ name, kind, range: range(index + 1, line.indexOf(name) + 1, name.length), exported: Boolean(declaration[1]), confidence: "exact" });
    }
    const imported = line.match(/^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']/) || line.match(/^\s*import\s+["']([^"']+)["']/);
    if (imported) {
      const source = imported.length > 2 ? imported[2] : imported[1];
      const clause = imported.length > 2 ? imported[1] : "";
      const names = [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map((entry) => entry[0]).filter((name) => !["as", "type"].includes(name));
      imports.push({ source, names, line: index + 1, confidence: "exact" });
    }
    const required = line.match(/require\(\s*["']([^"']+)["']\s*\)/);
    if (required) imports.push({ source: required[1], names: [], line: index + 1, confidence: "exact" });
  }
  return { symbols, imports, references: references(content, new Set(symbols.map((symbol) => symbol.name))) };
}

function pythonIndex(content: string) {
  const symbols: IndexedSymbol[] = [];
  const imports: IndexedImport[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const declaration = line.match(/^\s*(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/) || line.match(/^([A-Za-z_][\w]*)\s*=/);
    if (declaration) {
      const name = declaration[2] || declaration[1];
      symbols.push({ name, kind: declaration[1] === "def" ? "function" : declaration[1] === "class" ? "class" : "variable", range: range(index + 1, line.indexOf(name) + 1, name.length), exported: !name.startsWith("_"), confidence: "exact" });
    }
    const fromImport = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
    if (fromImport) imports.push({ source: fromImport[1], names: fromImport[2].replace(/[()]/g, "").split(",").map((name) => name.trim().split(/\s+as\s+/).at(-1) || "").filter(Boolean), line: index + 1, confidence: "exact" });
    const directImport = line.match(/^\s*import\s+(.+)$/);
    if (directImport) for (const entry of directImport[1].split(",")) imports.push({ source: entry.trim().split(/\s+as\s+/)[0], names: [], line: index + 1, confidence: "exact" });
  }
  return { symbols, imports, references: references(content, new Set(symbols.map((symbol) => symbol.name)), true) };
}

function genericIndex(content: string) {
  const symbols: IndexedSymbol[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const declaration = line.match(/^\s*function\s+(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)/) ||
      line.match(/^\s*(?:pub(?:lic)?\s+|private\s+|protected\s+|static\s+|async\s+)*(?:fn|function|class|struct|interface|trait|enum|type)\s+([A-Za-z_][\w]*)/) ||
      line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/) ||
      line.match(/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*(?:[A-Za-z_][\w<>,?.\[\]]*\s+)+([A-Za-z_][\w]*)\s*\(/);
    if (!declaration) continue;
    const name = declaration[1];
    symbols.push({ name, kind: /(?:class|struct)/.test(line) ? "class" : /(?:interface|trait|enum|type)/.test(line) ? "type" : "function", range: range(index + 1, line.indexOf(name) + 1, name.length), exported: /\b(?:pub|public)\b/.test(line), confidence: "heuristic" });
  }
  return { symbols, imports: [] as IndexedImport[], references: references(content, new Set(symbols.map((symbol) => symbol.name))) };
}

const ADAPTERS: LanguageAdapter[] = [
  { id: "javascript-typescript", version: 2, extensions: new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]), index: jsIndex },
  { id: "python", version: 2, extensions: new Set([".py", ".pyi", ".pyw"]), index: pythonIndex },
];

export const LANGUAGE_ADAPTER_VERSIONS = Object.fromEntries([...ADAPTERS, { id: "generic", version: 2 }].map((adapter) => [adapter.id, adapter.version]));

export function indexLanguageFile(filePath: string, content: string): LanguageIndexResult {
  const extension = path.extname(filePath).toLowerCase();
  const adapter = ADAPTERS.find((candidate) => candidate.extensions.has(extension));
  const indexed = adapter ? adapter.index(content) : genericIndex(content);
  return {
    language: adapter?.id || extension.replace(/^\./, "") || "plaintext",
    adapterId: adapter?.id || "generic",
    adapterVersion: adapter?.version || 1,
    ...indexed,
  };
}
