import path from "node:path";
import ts from "typescript";
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
  index(filePath: string, content: string): Omit<LanguageIndexResult, "language" | "adapterId" | "adapterVersion">;
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

function scriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js": case ".mjs": case ".cjs": return ts.ScriptKind.JS;
    case ".vue": case ".svelte": return ts.ScriptKind.TSX;
    default: return ts.ScriptKind.TS;
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function astRange(sourceFile: ts.SourceFile, node: ts.Node): RepositoryRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function identifierName(node: ts.Node | undefined): ts.Identifier | null {
  return node && ts.isIdentifier(node) ? node : null;
}

function bindingIdentifiers(node: ts.Node | undefined): ts.Identifier[] {
  if (!node) return [];
  if (ts.isIdentifier(node)) return [node];
  if (ts.isBindingElement(node)) return bindingIdentifiers(node.name);
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    return node.elements.flatMap((element) => bindingIdentifiers(element));
  }
  return [];
}

function addAstImport(
  imports: IndexedImport[],
  sourceFile: ts.SourceFile,
  source: string,
  names: string[],
  position: number
): void {
  imports.push({
    source,
    names: [...new Set(names.filter(Boolean))],
    line: sourceFile.getLineAndCharacterOfPosition(position).line + 1,
    confidence: "exact",
  });
}

interface LocalExportAlias {
  local: string;
  exported: string;
}

function astIndex(filePath: string, content: string) {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath)
  );
  const symbols: IndexedSymbol[] = [];
  const imports: IndexedImport[] = [];
  const localExportAliases: LocalExportAlias[] = [];
  const declarationPositions = new Set<number>();
  const ignoredReferenceRanges: Array<{ start: number; end: number }> = [];

  const addSymbol = (nameNode: ts.Node, kind: IndexedSymbol["kind"], owner: ts.Node): void => {
    const name = identifierName(nameNode);
    if (!name) return;
    declarationPositions.add(name.getStart(sourceFile));
    const exportOwner = ts.isVariableDeclaration(owner) && ts.isVariableStatement(owner.parent.parent)
      ? owner.parent.parent
      : owner;
    symbols.push({
      name: name.text,
      kind,
      range: astRange(sourceFile, name),
      exported: hasModifier(exportOwner, ts.SyntaxKind.ExportKeyword),
      confidence: "exact",
    });
  };

  const markBindings = (node: ts.Node | undefined): void => {
    for (const identifier of bindingIdentifiers(node)) {
      declarationPositions.add(identifier.getStart(sourceFile));
    }
  };

  const hasParameters = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);

  const visitDeclarations = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      ignoredReferenceRanges.push({ start: node.getStart(sourceFile), end: node.getEnd() });
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name) {
        names.push(clause.name.text);
        declarationPositions.add(clause.name.getStart(sourceFile));
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push(clause.namedBindings.name.text);
          declarationPositions.add(clause.namedBindings.name.getStart(sourceFile));
        } else {
          for (const element of clause.namedBindings.elements) {
            names.push(element.name.text);
            if (element.propertyName) names.push(element.propertyName.text);
            declarationPositions.add(element.name.getStart(sourceFile));
            if (element.propertyName) declarationPositions.add(element.propertyName.getStart(sourceFile));
          }
        }
      }
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addAstImport(imports, sourceFile, node.moduleSpecifier.text, names, node.getStart(sourceFile));
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      ignoredReferenceRanges.push({ start: node.getStart(sourceFile), end: node.getEnd() });
      const names: string[] = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          names.push(element.name.text);
          if (element.propertyName) names.push(element.propertyName.text);
          if (!node.moduleSpecifier) {
            localExportAliases.push({
              local: element.propertyName?.text || element.name.text,
              exported: element.name.text,
            });
          }
        }
      }
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addAstImport(imports, sourceFile, node.moduleSpecifier.text, names, node.getStart(sourceFile));
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      ignoredReferenceRanges.push({ start: node.getStart(sourceFile), end: node.getEnd() });
      declarationPositions.add(node.name.getStart(sourceFile));
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression && ts.isStringLiteral(reference.expression)) {
        addAstImport(imports, sourceFile, reference.expression.text, [node.name.text], node.getStart(sourceFile));
      }
      return;
    }

    if (hasParameters(node)) for (const parameter of node.parameters) markBindings(parameter.name);
    if (ts.isFunctionDeclaration(node) && node.name) addSymbol(node.name, "function", node);
    else if (ts.isClassDeclaration(node) && node.name) addSymbol(node.name, "class", node);
    else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) addSymbol(node.name, "type", node);
    else if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) addSymbol(node.name, "function", node);
    else if (ts.isVariableDeclaration(node)) {
      markBindings(node.name);
      for (const identifier of bindingIdentifiers(node.name)) addSymbol(identifier, "variable", node);
    }
    if (ts.isCatchClause(node)) markBindings(node.variableDeclaration?.name);
    if (ts.isTypeParameterDeclaration(node)) declarationPositions.add(node.name.getStart(sourceFile));
    if (ts.isEnumMember(node) && ts.isIdentifier(node.name)) declarationPositions.add(node.name.getStart(sourceFile));

    const initializer = ts.isVariableDeclaration(node) ? node.initializer : undefined;
    if (initializer && ts.isCallExpression(initializer)) {
      const [requiredArgument] = initializer.arguments;
      if (ts.isIdentifier(initializer.expression) && initializer.expression.text === "require" &&
          requiredArgument && ts.isStringLiteral(requiredArgument)) {
        const localName = ts.isVariableDeclaration(node) ? identifierName(node.name)?.text || "" : "";
        addAstImport(imports, sourceFile, requiredArgument.text, [localName], node.getStart(sourceFile));
      }
    }
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(sourceFile);

  // Materialize local re-export aliases as additional ranges pointing at the
  // original declaration. This lets exact symbol lookup resolve `export {
  // localName as publicName }` without weakening the lexical fallback.
  for (const alias of localExportAliases) {
    if (alias.exported === "default") continue;
    const original = symbols.find((symbol) => symbol.name === alias.local);
    if (!original || symbols.some((symbol) => symbol.name === alias.exported &&
        symbol.range.startLine === original.range.startLine &&
        symbol.range.startColumn === original.range.startColumn)) continue;
    symbols.push({ ...original, name: alias.exported, exported: true });
  }

  const isIgnored = (node: ts.Node): boolean => ignoredReferenceRanges.some((range) => {
    const start = node.getStart(sourceFile);
    return start >= range.start && node.getEnd() <= range.end;
  });
  const referenceEntries: IndexedReference[] = [];
  const seenReferences = new Set<string>();
  const visitReferences = (node: ts.Node): void => {
    if (isIgnored(node)) return;
    if (ts.isIdentifier(node) && !declarationPositions.has(node.getStart(sourceFile))) {
      const parent = node.parent;
      const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node);
      if (!propertyName && !seenReferences.has(node.text)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        referenceEntries.push({ symbol: node.text, line: position.line + 1, column: position.character + 1, confidence: "lexical" });
        seenReferences.add(node.text);
      }
    }
    if (referenceEntries.length < MAX_REFERENCES_PER_FILE) ts.forEachChild(node, visitReferences);
  };
  visitReferences(sourceFile);

  return { symbols, imports, references: referenceEntries };
}

function jsIndex(filePath: string, content: string) {
  try {
    return astIndex(filePath, content);
  } catch {
    // Keep indexing resilient for embedded or partially edited documents.
    const symbols: IndexedSymbol[] = [];
    const imports: IndexedImport[] = [];
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const declaration = line.match(/^\s*(export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/);
      if (declaration) {
        const name = declaration[3];
        const rawKind = declaration[2];
        const kind: IndexedSymbol["kind"] = rawKind === "function" ? "function" : rawKind === "class" ? "class" : ["interface", "type", "enum"].includes(rawKind) ? "type" : "variable";
        symbols.push({ name, kind, range: range(index + 1, line.indexOf(name) + 1, name.length), exported: Boolean(declaration[1]), confidence: "heuristic" });
      }
      const imported = line.match(/^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']/) || line.match(/^\s*import\s+["']([^"']+)["']/);
      if (imported) {
        const source = imported.length > 2 ? imported[2] : imported[1];
        const clause = imported.length > 2 ? imported[1] : "";
        const names = [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map((entry) => entry[0]).filter((name) => !["as", "type"].includes(name));
        imports.push({ source, names, line: index + 1, confidence: "heuristic" });
      }
    }
    return { symbols, imports, references: references(content, new Set(symbols.map((symbol) => symbol.name))) };
  }
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
  { id: "javascript-typescript", version: 4, extensions: new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]), index: jsIndex },
  { id: "python", version: 2, extensions: new Set([".py", ".pyi", ".pyw"]), index: (_filePath, content) => pythonIndex(content) },
];

export const LANGUAGE_ADAPTER_VERSIONS = Object.fromEntries([...ADAPTERS, { id: "generic", version: 2 }].map((adapter) => [adapter.id, adapter.version]));

export function indexLanguageFile(filePath: string, content: string): LanguageIndexResult {
  const extension = path.extname(filePath).toLowerCase();
  const adapter = ADAPTERS.find((candidate) => candidate.extensions.has(extension));
  const indexed = adapter ? adapter.index(filePath, content) : genericIndex(content);
  return {
    language: adapter?.id || extension.replace(/^\./, "") || "plaintext",
    adapterId: adapter?.id || "generic",
    adapterVersion: adapter?.version || 1,
    ...indexed,
  };
}
