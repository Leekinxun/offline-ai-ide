import * as monaco from "monaco-editor";

const TOKEN_TYPES = [
  "namespace",
  "class",
  "type",
  "function",
  "method",
  "parameter",
  "property",
  "variable",
  "decorator",
] as const;

const TOKEN_MODIFIERS = ["declaration", "readonly", "async"] as const;

type TokenTypeName = (typeof TOKEN_TYPES)[number];
type TokenModifierName = (typeof TOKEN_MODIFIERS)[number];

interface SemanticTokenEntry {
  line: number;
  start: number;
  length: number;
  type: TokenTypeName;
  modifiers: TokenModifierName[];
}

interface AddTokenOptions {
  allowProtected?: boolean;
}

interface ProtectedRange {
  start: number;
  end: number;
}

interface BlockRange {
  startLine: number;
  endLine: number;
  indent: number;
}

interface PythonClassBlock extends BlockRange {
  decorators: string[];
  framework:
    | "plain"
    | "dataclass"
    | "attrs"
    | "pydantic"
    | "typedDict"
    | "namedTuple"
    | "enum";
}

const TOKEN_TYPE_INDEX = new Map(
  TOKEN_TYPES.map((type, index) => [type, index])
);

const TOKEN_MODIFIER_INDEX = new Map(
  TOKEN_MODIFIERS.map((modifier, index) => [modifier, index])
);

const PYTHON_BUILTIN_TYPES = new Set([
  "Annotated",
  "Any",
  "AsyncGenerator",
  "AsyncIterable",
  "AsyncIterator",
  "Awaitable",
  "BinaryIO",
  "Callable",
  "ClassVar",
  "Coroutine",
  "Dict",
  "Final",
  "FrozenSet",
  "Generator",
  "Generic",
  "IO",
  "Iterable",
  "Iterator",
  "List",
  "Literal",
  "Mapping",
  "Never",
  "NoReturn",
  "NotRequired",
  "Optional",
  "ParamSpec",
  "Protocol",
  "Required",
  "Self",
  "Sequence",
  "Set",
  "TextIO",
  "Tuple",
  "Type",
  "TypeAlias",
  "TypeGuard",
  "TypeVar",
  "TypedDict",
  "Union",
  "bool",
  "bytes",
  "complex",
  "dict",
  "float",
  "frozenset",
  "int",
  "list",
  "set",
  "str",
  "tuple",
]);

const PYTHON_CALL_EXCLUSIONS = new Set([
  "and",
  "assert",
  "case",
  "class",
  "def",
  "del",
  "elif",
  "except",
  "for",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "not",
  "or",
  "return",
  "while",
  "with",
  "yield",
]);

const PYTHON_METHOD_DECORATORS = new Set([
  "abstractmethod",
  "cached_property",
  "classmethod",
  "property",
  "setter",
  "staticmethod",
]);

const PYTHON_CASE_CAPTURE_EXCLUSIONS = new Set([
  "_",
  "False",
  "None",
  "True",
  "and",
  "as",
  "case",
  "if",
  "in",
  "is",
  "not",
  "or",
]);

const PYTHON_DATACLASS_DECORATORS = new Set(["dataclass"]);

const PYTHON_ATTRS_DECORATORS = new Set([
  "attrs",
  "define",
  "frozen",
  "mutable",
  "s",
]);

const PYTHON_TYPED_DICT_BASES = new Set(["TypedDict"]);

const PYTHON_NAMED_TUPLE_BASES = new Set(["NamedTuple"]);

const PYTHON_ENUM_BASES = new Set([
  "Enum",
  "Flag",
  "IntEnum",
  "IntFlag",
  "ReprEnum",
  "StrEnum",
]);

const PYTHON_PYDANTIC_BASES = new Set([
  "BaseModel",
  "BaseSettings",
  "GenericModel",
  "RootModel",
  "SQLModel",
]);

const PYTHON_SPECIAL_TYPE_FACTORY_CALLS = new Set([
  ...PYTHON_TYPED_DICT_BASES,
  ...PYTHON_NAMED_TUPLE_BASES,
  ...PYTHON_ENUM_BASES,
]);

const PYTHON_FIELD_FACTORY_SUFFIXES = new Set([
  "Field",
  "FieldInfo",
  "Factory",
  "PrivateAttr",
  "Relationship",
  "attrib",
  "field",
  "ib",
  "mapped_column",
]);

class SemanticTokenBuffer {
  private readonly tokens: SemanticTokenEntry[] = [];
  private readonly occupiedByLine = new Map<
    number,
    Array<{ start: number; end: number }>
  >();

  constructor(
    private readonly model: monaco.editor.ITextModel,
    private readonly protectedRanges: Map<number, ProtectedRange[]>
  ) {}

  add(
    line: number,
    start: number,
    length: number,
    type: TokenTypeName,
    modifiers: TokenModifierName[] = [],
    options: AddTokenOptions = {}
  ): void {
    if (line < 0 || start < 0 || length <= 0) return;
    if (!options.allowProtected && this.isProtected(line, start, length)) return;

    const end = start + length;
    const ranges = this.occupiedByLine.get(line) || [];
    for (const range of ranges) {
      if (start < range.end && end > range.start) {
        return;
      }
    }

    ranges.push({ start, end });
    this.occupiedByLine.set(line, ranges);
    this.tokens.push({ line, start, length, type, modifiers });
  }

  addOffset(
    offset: number,
    length: number,
    type: TokenTypeName,
    modifiers: TokenModifierName[] = [],
    options: AddTokenOptions = {}
  ): void {
    if (length <= 0) return;

    const startPosition = this.model.getPositionAt(offset);
    const endPosition = this.model.getPositionAt(offset + length);
    if (startPosition.lineNumber !== endPosition.lineNumber) return;

    this.add(
      startPosition.lineNumber - 1,
      startPosition.column - 1,
      length,
      type,
      modifiers,
      options
    );
  }

  encode(): Uint32Array {
    this.tokens.sort((left, right) =>
      left.line === right.line
        ? left.start - right.start
        : left.line - right.line
    );

    let previousLine = 0;
    let previousStart = 0;
    const data: number[] = [];

    for (const token of this.tokens) {
      const deltaLine = token.line - previousLine;
      const deltaStart =
        deltaLine === 0 ? token.start - previousStart : token.start;

      data.push(
        deltaLine,
        deltaStart,
        token.length,
        TOKEN_TYPE_INDEX.get(token.type) ?? 0,
        token.modifiers.reduce((mask, modifier) => {
          const index = TOKEN_MODIFIER_INDEX.get(modifier);
          return index === undefined ? mask : mask | (1 << index);
        }, 0)
      );

      previousLine = token.line;
      previousStart = token.start;
    }

    return new Uint32Array(data);
  }

  private isProtected(line: number, start: number, length: number): boolean {
    const ranges = this.protectedRanges.get(line);
    if (!ranges?.length) return false;

    const end = start + length;
    return ranges.some((range) => start < range.end && end > range.start);
  }
}

function buildProtectedRanges(
  model: monaco.editor.ITextModel
): Map<number, ProtectedRange[]> {
  const lines = model.getLinesContent();
  const tokenizedLines = monaco.editor.tokenize(model.getValue(), "python");
  const protectedRanges = new Map<number, ProtectedRange[]>();

  tokenizedLines.forEach((tokens, lineIndex) => {
    const ranges: ProtectedRange[] = [];
    const lineLength = lines[lineIndex]?.length ?? 0;

    tokens.forEach((token, tokenIndex) => {
      const end =
        tokenIndex + 1 < tokens.length ? tokens[tokenIndex + 1].offset : lineLength;
      if (end <= token.offset) return;

      if (token.type.includes("comment") || token.type.includes("string")) {
        ranges.push({ start: token.offset, end });
      }
    });

    if (ranges.length > 0) {
      protectedRanges.set(lineIndex, ranges);
    }
  });

  return protectedRanges;
}

function maskLine(line: string, ranges: ProtectedRange[]): string {
  if (ranges.length === 0) return line;

  let masked = "";
  let cursor = 0;
  for (const range of ranges) {
    masked += line.slice(cursor, range.start);
    masked += " ".repeat(range.end - range.start);
    cursor = range.end;
  }
  masked += line.slice(cursor);
  return masked;
}

function getIndentWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

function getLineStartOffset(
  model: monaco.editor.ITextModel,
  lineIndex: number
): number {
  return model.getOffsetAt({ lineNumber: lineIndex + 1, column: 1 });
}

function getLineIndexFromOffset(
  model: monaco.editor.ITextModel,
  text: string,
  offset: number
): number {
  if (text.length === 0) return 0;

  let resolvedOffset = Math.max(0, Math.min(offset, text.length - 1));
  if (text[resolvedOffset] === "\n" && resolvedOffset > 0) {
    resolvedOffset -= 1;
  }

  return model.getPositionAt(resolvedOffset).lineNumber - 1;
}

function findStatementEnd(text: string, startOffset: number): number {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let previousNonWhitespace = "";

  for (let index = startOffset; index < text.length; index += 1) {
    const char = text[index];

    if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(roundDepth - 1, 0);
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(squareDepth - 1, 0);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(curlyDepth - 1, 0);
    else if (char === "\n") {
      if (
        roundDepth === 0 &&
        squareDepth === 0 &&
        curlyDepth === 0 &&
        previousNonWhitespace !== "\\"
      ) {
        return index;
      }
      previousNonWhitespace = "";
      continue;
    }

    if (!/\s/.test(char)) {
      previousNonWhitespace = char;
    }
  }

  return text.length;
}

function findMatchingBracket(text: string, openOffset: number): number {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = openOffset; index < text.length; index += 1) {
    const char = text[index];

    if (char === "(") roundDepth += 1;
    else if (char === ")") {
      roundDepth = Math.max(roundDepth - 1, 0);
      if (roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
        return index;
      }
    } else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(squareDepth - 1, 0);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(curlyDepth - 1, 0);
  }

  return -1;
}

function findTopLevelChar(
  text: string,
  startOffset: number,
  endOffset: number,
  target: string
): number {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = startOffset; index < endOffset; index += 1) {
    const char = text[index];

    if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(roundDepth - 1, 0);
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(squareDepth - 1, 0);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(curlyDepth - 1, 0);
    else if (
      char === target &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

function findTopLevelSequence(
  text: string,
  startOffset: number,
  endOffset: number,
  target: string
): number {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = startOffset; index <= endOffset - target.length; index += 1) {
    const char = text[index];

    if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(roundDepth - 1, 0);
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(squareDepth - 1, 0);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(curlyDepth - 1, 0);

    if (
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      text.slice(index, index + target.length) === target
    ) {
      return index;
    }
  }

  return -1;
}

function splitTopLevelSegments(
  source: string
): Array<{ text: string; start: number }> {
  const segments: Array<{ text: string; start: number }> = [];
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let segmentStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(roundDepth - 1, 0);
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(squareDepth - 1, 0);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(curlyDepth - 1, 0);
    else if (
      char === "," &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0
    ) {
      segments.push({
        text: source.slice(segmentStart, index),
        start: segmentStart,
      });
      segmentStart = index + 1;
    }
  }

  if (segmentStart <= source.length) {
    segments.push({
      text: source.slice(segmentStart),
      start: segmentStart,
    });
  }

  return segments;
}

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_]/.test(char);
}

function stripOuterGrouping(
  source: string
): { text: string; startOffset: number } {
  let workingSource = source;
  let totalOffset = 0;

  while (workingSource.length > 0) {
    const leadingWhitespace = workingSource.match(/^\s*/)?.[0].length ?? 0;
    const trailingWhitespace = workingSource.match(/\s*$/)?.[0].length ?? 0;
    const startIndex = leadingWhitespace;
    const endIndex = workingSource.length - trailingWhitespace - 1;

    if (startIndex >= endIndex) break;

    const opener = workingSource[startIndex];
    const closer = opener === "(" ? ")" : opener === "[" ? "]" : null;
    if (!closer || workingSource[endIndex] !== closer) break;

    const matchedEnd = findMatchingBracket(workingSource, startIndex);
    if (matchedEnd !== endIndex) break;

    totalOffset += startIndex + 1;
    workingSource = workingSource.slice(startIndex + 1, endIndex);
  }

  return { text: workingSource, startOffset: totalOffset };
}

function findTopLevelAssignmentOperators(source: string): number[] {
  const operators: number[] = [];
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(roundDepth - 1, 0);
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(squareDepth - 1, 0);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(curlyDepth - 1, 0);
    else if (
      char === "=" &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0
    ) {
      const previousChar = source[index - 1] || "";
      const nextChar = source[index + 1] || "";

      if (
        previousChar === ":" ||
        previousChar === "=" ||
        previousChar === "!" ||
        previousChar === "<" ||
        previousChar === ">" ||
        previousChar === "+" ||
        previousChar === "-" ||
        previousChar === "*" ||
        previousChar === "/" ||
        previousChar === "%" ||
        previousChar === "&" ||
        previousChar === "|" ||
        previousChar === "^" ||
        previousChar === "@" ||
        nextChar === "="
      ) {
        continue;
      }

      operators.push(index);
    }
  }

  return operators;
}

function findTopLevelKeywordOffsets(source: string, keyword: string): number[] {
  const offsets: number[] = [];
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = 0; index <= source.length - keyword.length; index += 1) {
    const char = source[index];

    if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(roundDepth - 1, 0);
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(squareDepth - 1, 0);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(curlyDepth - 1, 0);

    if (roundDepth !== 0 || squareDepth !== 0 || curlyDepth !== 0) {
      continue;
    }

    if (source.slice(index, index + keyword.length) !== keyword) {
      continue;
    }

    if (
      isIdentifierChar(source[index - 1]) ||
      isIdentifierChar(source[index + keyword.length])
    ) {
      continue;
    }

    offsets.push(index);
  }

  return offsets;
}

function shouldTreatAsTypeName(name: string): boolean {
  return PYTHON_BUILTIN_TYPES.has(name) || /^[A-Z][A-Za-z0-9_]*$/.test(name);
}

function isReadonlyName(name: string): boolean {
  return /[A-Z]/.test(name) && name === name.toUpperCase();
}

function inferImportedDeclaration(
  name: string
): { type: TokenTypeName; modifiers: TokenModifierName[] } {
  const modifiers: TokenModifierName[] = ["declaration"];

  if (PYTHON_BUILTIN_TYPES.has(name)) {
    return { type: "type", modifiers };
  }

  if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) {
    return { type: "class", modifiers };
  }

  if (isReadonlyName(name)) {
    return { type: "variable", modifiers: [...modifiers, "readonly"] };
  }

  return { type: "variable", modifiers };
}

function collectAssignmentTargetPattern(
  buffer: SemanticTokenBuffer,
  source: string,
  baseOffset: number
): void {
  const unwrapped = stripOuterGrouping(source);
  const workingSource = unwrapped.text;
  const workingOffset = baseOffset + unwrapped.startOffset;
  const segments = splitTopLevelSegments(workingSource);

  if (segments.length > 1) {
    for (const segment of segments) {
      collectAssignmentTargetPattern(
        buffer,
        segment.text,
        workingOffset + segment.start
      );
    }
    return;
  }

  const trimmedSource = workingSource.trim();
  if (!trimmedSource) return;

  const trimmedOffset = workingOffset + workingSource.indexOf(trimmedSource);
  const colonOffset = findTopLevelChar(
    trimmedSource,
    0,
    trimmedSource.length,
    ":"
  );
  if (colonOffset >= 0) {
    collectAssignmentTargetPattern(
      buffer,
      trimmedSource.slice(0, colonOffset),
      trimmedOffset
    );
    return;
  }

  const starredTargetMatch = /^(\*{1,2})\s*(.+)$/.exec(trimmedSource);
  if (starredTargetMatch) {
    const starredPrefix = starredTargetMatch[1];
    const targetSource = starredTargetMatch[2];
    if (!targetSource) return;

    const targetOffset = trimmedOffset + trimmedSource.indexOf(targetSource);
    collectAssignmentTargetPattern(buffer, targetSource, targetOffset);
    if (starredPrefix.length > 2) return;
    return;
  }

  const directNameMatch = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmedSource);
  if (!directNameMatch?.[1]) return;

  const name = directNameMatch[1];
  if (name === "self" || name === "cls") return;

  const modifiers: TokenModifierName[] = ["declaration"];
  if (isReadonlyName(name)) {
    modifiers.push("readonly");
  }

  buffer.addOffset(trimmedOffset, name.length, "variable", modifiers);
}

function addQualifiedNamespace(
  buffer: SemanticTokenBuffer,
  offset: number,
  qualifiedName: string,
  firstModifiers: TokenModifierName[] = []
): void {
  let cursor = offset;
  const parts = qualifiedName.split(".");

  parts.forEach((part, index) => {
    if (!part) return;

    buffer.addOffset(
      cursor,
      part.length,
      "namespace",
      index === 0 ? firstModifiers : []
    );

    cursor += part.length;
    if (index < parts.length - 1) {
      cursor += 1;
    }
  });
}

function collectTypeIdentifiers(
  buffer: SemanticTokenBuffer,
  source: string,
  baseOffset: number
): void {
  const matcher =
    /\b(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*\b/g;

  for (const match of source.matchAll(matcher)) {
    const qualifiedName = match[0];
    if (!qualifiedName) continue;

    const parts = qualifiedName.split(".");
    const finalName = parts[parts.length - 1];
    if (!shouldTreatAsTypeName(finalName)) continue;

    let cursor = baseOffset + (match.index ?? 0);
    parts.forEach((part, index) => {
      if (!part) return;

      buffer.addOffset(
        cursor,
        part.length,
        index === parts.length - 1 ? "type" : "namespace"
      );

      cursor += part.length;
      if (index < parts.length - 1) {
        cursor += 1;
      }
    });
  }
}

function collectPythonParameters(
  buffer: SemanticTokenBuffer,
  source: string,
  baseOffset: number
): void {
  for (const segment of splitTopLevelSegments(source)) {
    const trimmed = segment.text.trim();
    if (!trimmed || trimmed === "/" || trimmed === "*") continue;

    const nameMatch = /^\s*\*{0,2}([A-Za-z_][A-Za-z0-9_]*)/.exec(segment.text);
    const name = nameMatch?.[1];
    if (!name) continue;

    const nameOffsetInSegment = segment.text.indexOf(name);
    if (nameOffsetInSegment < 0) continue;

    buffer.addOffset(
      baseOffset + segment.start + nameOffsetInSegment,
      name.length,
      "parameter",
      ["declaration"]
    );

    const colonIndex = findTopLevelChar(segment.text, 0, segment.text.length, ":");
    if (colonIndex < 0) continue;

    const equalsIndex = findTopLevelChar(
      segment.text,
      colonIndex + 1,
      segment.text.length,
      "="
    );
    const annotationEnd =
      equalsIndex >= 0 ? equalsIndex : segment.text.length;
    const annotationSource = segment.text.slice(colonIndex + 1, annotationEnd).trim();
    if (!annotationSource) continue;

    const annotationOffsetInSegment = segment.text.indexOf(
      annotationSource,
      colonIndex + 1
    );
    if (annotationOffsetInSegment < 0) continue;

    collectTypeIdentifiers(
      buffer,
      annotationSource,
      baseOffset + segment.start + annotationOffsetInSegment
    );
  }
}

function getDecoratorNamesForLine(
  maskedLines: string[],
  lineIndex: number
): string[] {
  const decorators: string[] = [];

  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const trimmed = maskedLines[index].trim();
    if (!trimmed) break;
    if (!trimmed.startsWith("@")) break;

    const match = /^@([A-Za-z_][\w.]*)/.exec(trimmed);
    if (!match?.[1]) continue;

    decorators.unshift(match[1].split(".").pop() || match[1]);
  }

  return decorators;
}

function findIndentedBlockEnd(
  lines: string[],
  bodyStartLine: number,
  parentIndent: number
): number {
  let lastBodyLine = bodyStartLine - 1;

  for (let index = bodyStartLine; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;

    const indentWidth = getIndentWidth(lines[index]);
    if (indentWidth <= parentIndent) {
      return Math.max(lastBodyLine, bodyStartLine - 1);
    }

    lastBodyLine = index;
  }

  return Math.max(lastBodyLine, bodyStartLine - 1);
}

function lineInsideBlock(lineIndex: number, blocks: BlockRange[]): boolean {
  return blocks.some(
    (block) => lineIndex >= block.startLine && lineIndex <= block.endLine
  );
}

function getContainingBlock<T extends BlockRange>(
  lineIndex: number,
  blocks: T[]
): T | null {
  for (const block of blocks) {
    if (lineIndex >= block.startLine && lineIndex <= block.endLine) {
      return block;
    }
  }

  return null;
}

function extractQualifiedNames(source: string): string[] {
  const qualifiedNameMatcher =
    /\b(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*\b/g;
  const names = new Set<string>();

  for (const match of source.matchAll(qualifiedNameMatcher)) {
    const qualifiedName = match[0];
    if (!qualifiedName) continue;

    const finalName = qualifiedName.split(".").pop() || qualifiedName;
    names.add(finalName);
  }

  return Array.from(names);
}

function resolveClassFramework(
  decorators: string[],
  baseNames: string[]
): PythonClassBlock["framework"] {
  if (decorators.some((decorator) => PYTHON_DATACLASS_DECORATORS.has(decorator))) {
    return "dataclass";
  }

  if (decorators.some((decorator) => PYTHON_ATTRS_DECORATORS.has(decorator))) {
    return "attrs";
  }

  if (baseNames.some((baseName) => PYTHON_TYPED_DICT_BASES.has(baseName))) {
    return "typedDict";
  }

  if (baseNames.some((baseName) => PYTHON_NAMED_TUPLE_BASES.has(baseName))) {
    return "namedTuple";
  }

  if (baseNames.some((baseName) => PYTHON_ENUM_BASES.has(baseName))) {
    return "enum";
  }

  if (baseNames.some((baseName) => PYTHON_PYDANTIC_BASES.has(baseName))) {
    return "pydantic";
  }

  return "plain";
}

function isClassVarAnnotation(annotationSource: string): boolean {
  return /\b(?:typing\.)?ClassVar\b/.test(annotationSource);
}

function isFinalAnnotation(annotationSource: string): boolean {
  return /\b(?:typing\.)?Final\b/.test(annotationSource);
}

function getLeadingCallName(expressionSource: string): string | null {
  const trimmedSource = expressionSource.trim();
  const match = /^((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
    trimmedSource
  );

  return match?.[1] || null;
}

function isKnownFieldFactoryCall(
  callName: string,
  classBlock: PythonClassBlock | null
): boolean {
  const suffix = callName.split(".").pop() || callName;
  if (!PYTHON_FIELD_FACTORY_SUFFIXES.has(suffix)) return false;

  if (
    suffix === "Field" ||
    suffix === "FieldInfo" ||
    suffix === "PrivateAttr" ||
    suffix === "Relationship" ||
    suffix === "mapped_column"
  ) {
    return true;
  }

  if (!classBlock) return false;
  return classBlock.framework === "attrs" || classBlock.framework === "dataclass";
}

function shouldCaptureCasePatternName(
  patternSource: string,
  index: number,
  name: string
): boolean {
  if (
    PYTHON_CASE_CAPTURE_EXCLUSIONS.has(name) ||
    shouldTreatAsTypeName(name) ||
    isReadonlyName(name)
  ) {
    return false;
  }

  let previousIndex = index - 1;
  while (previousIndex >= 0 && /\s/.test(patternSource[previousIndex])) {
    previousIndex -= 1;
  }
  if (previousIndex >= 0 && patternSource[previousIndex] === ".") {
    return false;
  }

  let nextIndex = index + name.length;
  while (nextIndex < patternSource.length && /\s/.test(patternSource[nextIndex])) {
    nextIndex += 1;
  }

  const nextChar = patternSource[nextIndex];
  if (nextChar === "." || nextChar === "(" || nextChar === "=") {
    return false;
  }

  return true;
}

function getAlignedSegments(
  maskedSource: string,
  rawSource: string
): Array<{ start: number; masked: string; raw: string }> {
  return splitTopLevelSegments(maskedSource).map((segment) => ({
    start: segment.start,
    masked: segment.text,
    raw: rawSource.slice(segment.start, segment.start + segment.text.length),
  }));
}

function parseStringLiteral(
  source: string
): { content: string; contentOffset: number } | null {
  const match =
    /^\s*([rRuUbBfF]{0,3})('''|"""|'|")([\s\S]*?)\2\s*$/.exec(source);
  if (!match) return null;

  const leadingWhitespaceLength = source.match(/^\s*/)?.[0].length ?? 0;
  const prefixLength = match[1]?.length ?? 0;
  const quoteLength = match[2]?.length ?? 0;

  return {
    content: match[3] ?? "",
    contentOffset: leadingWhitespaceLength + prefixLength + quoteLength,
  };
}

function addStringLiteralIdentifier(
  buffer: SemanticTokenBuffer,
  rawSource: string,
  baseOffset: number,
  type: TokenTypeName,
  modifiers: TokenModifierName[] = []
): void {
  const parsed = parseStringLiteral(rawSource);
  if (!parsed) return;

  const identifierMatch = /\b([A-Za-z_][A-Za-z0-9_]*)\b/.exec(parsed.content);
  if (!identifierMatch?.[1]) return;

  buffer.addOffset(
    baseOffset + parsed.contentOffset + (identifierMatch.index ?? 0),
    identifierMatch[1].length,
    type,
    modifiers,
    { allowProtected: true }
  );
}

function addStringLiteralIdentifiers(
  buffer: SemanticTokenBuffer,
  rawSource: string,
  baseOffset: number,
  type: TokenTypeName,
  modifiers: TokenModifierName[] = []
): void {
  const parsed = parseStringLiteral(rawSource);
  if (!parsed) return;

  const identifierMatcher = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const match of parsed.content.matchAll(identifierMatcher)) {
    const name = match[1];
    if (!name) continue;

    buffer.addOffset(
      baseOffset + parsed.contentOffset + (match.index ?? 0),
      name.length,
      type,
      modifiers,
      { allowProtected: true }
    );
  }
}

function collectStringKeysInDictLiteral(
  buffer: SemanticTokenBuffer,
  rawSource: string,
  maskedSource: string,
  baseOffset: number,
  type: TokenTypeName,
  modifiers: TokenModifierName[] = []
): void {
  const trimmedRaw = rawSource.trim();
  const trimmedMasked = maskedSource.trim();
  if (
    trimmedRaw.length < 2 ||
    trimmedMasked.length < 2 ||
    trimmedRaw[0] !== "{" ||
    trimmedMasked[0] !== "{" ||
    trimmedRaw[trimmedRaw.length - 1] !== "}" ||
    trimmedMasked[trimmedMasked.length - 1] !== "}"
  ) {
    return;
  }

  const bodyStart = rawSource.indexOf("{") + 1;
  const rawBody = rawSource.slice(bodyStart, rawSource.lastIndexOf("}"));
  const maskedBody = maskedSource.slice(bodyStart, maskedSource.lastIndexOf("}"));

  for (const segment of getAlignedSegments(maskedBody, rawBody)) {
    const colonOffset = findTopLevelChar(
      segment.masked,
      0,
      segment.masked.length,
      ":"
    );
    if (colonOffset < 0) continue;

    const keyRaw = segment.raw.slice(0, colonOffset);
    addStringLiteralIdentifier(
      buffer,
      keyRaw,
      baseOffset + bodyStart + segment.start,
      type,
      modifiers
    );
  }
}

function collectStringEntriesInSequence(
  buffer: SemanticTokenBuffer,
  rawSource: string,
  maskedSource: string,
  baseOffset: number,
  type: TokenTypeName,
  modifiers: TokenModifierName[] = []
): void {
  const trimmedRaw = rawSource.trim();
  const trimmedMasked = maskedSource.trim();
  if (
    trimmedRaw.length < 2 ||
    trimmedMasked.length < 2 ||
    !["[", "("].includes(trimmedRaw[0]) ||
    !["[", "("].includes(trimmedMasked[0])
  ) {
    return;
  }

  const closingChar = trimmedRaw[0] === "[" ? "]" : ")";
  if (
    trimmedRaw[trimmedRaw.length - 1] !== closingChar ||
    trimmedMasked[trimmedMasked.length - 1] !== closingChar
  ) {
    return;
  }

  const bodyStart = rawSource.indexOf(trimmedRaw[0]) + 1;
  const rawBody = rawSource.slice(bodyStart, rawSource.lastIndexOf(closingChar));
  const maskedBody = maskedSource.slice(
    bodyStart,
    maskedSource.lastIndexOf(closingChar)
  );

  for (const segment of getAlignedSegments(maskedBody, rawBody)) {
    const rawTrimmed = segment.raw.trim();
    const maskedTrimmed = segment.masked.trim();
    if (!rawTrimmed || !maskedTrimmed) continue;

    if (parseStringLiteral(rawTrimmed)) {
      addStringLiteralIdentifiers(
        buffer,
        segment.raw,
        baseOffset + bodyStart + segment.start,
        type,
        modifiers
      );
      continue;
    }

    if (!["[", "("].includes(rawTrimmed[0])) continue;

    const nestedClosingChar = rawTrimmed[0] === "[" ? "]" : ")";
    if (rawTrimmed[rawTrimmed.length - 1] !== nestedClosingChar) continue;

    const nestedBodyStart = segment.raw.indexOf(rawTrimmed[0]) + 1;
    const nestedRawBody = segment.raw.slice(
      nestedBodyStart,
      segment.raw.lastIndexOf(nestedClosingChar)
    );
    const nestedMaskedBody = segment.masked.slice(
      nestedBodyStart,
      segment.masked.lastIndexOf(nestedClosingChar)
    );
    const nestedParts = getAlignedSegments(nestedMaskedBody, nestedRawBody);
    if (nestedParts.length === 0) continue;

    addStringLiteralIdentifier(
      buffer,
      nestedParts[0].raw,
      baseOffset + bodyStart + segment.start + nestedBodyStart + nestedParts[0].start,
      type,
      modifiers
    );
  }
}

function collectDecorators(
  buffer: SemanticTokenBuffer,
  maskedText: string
): void {
  const decoratorMatcher = /(^|\n)([ \t]*)@([A-Za-z_][\w.]*)/g;

  for (const match of maskedText.matchAll(decoratorMatcher)) {
    const decoratorName = match[3];
    if (!decoratorName) continue;

    const absoluteOffset =
      (match.index ?? 0) + match[0].lastIndexOf(decoratorName);
    buffer.addOffset(absoluteOffset, decoratorName.length, "decorator");
  }
}

function collectPythonImports(
  buffer: SemanticTokenBuffer,
  maskedText: string
): void {
  const fromImportMatcher = /^([ \t]*)from\s+([A-Za-z_][\w.]*)\s+import\b/gm;

  for (const match of maskedText.matchAll(fromImportMatcher)) {
    const moduleName = match[2];
    if (!moduleName) continue;

    const statementStart = match.index ?? 0;
    const statementEnd = findStatementEnd(maskedText, statementStart);
    const importKeywordOffset = statementStart + match[0].length;
    const clauseSource = maskedText.slice(importKeywordOffset, statementEnd);

    addQualifiedNamespace(
      buffer,
      statementStart + match[0].lastIndexOf(moduleName),
      moduleName
    );

    const clauseMatcher =
      /\b([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/g;

    for (const clauseMatch of clauseSource.matchAll(clauseMatcher)) {
      const importedName = clauseMatch[1];
      const aliasName = clauseMatch[2];
      if (!importedName) continue;

      const declaredName = aliasName || importedName;
      const declaration = inferImportedDeclaration(declaredName);
      const localOffset =
        aliasName && clauseMatch[0].includes(aliasName)
          ? (clauseMatch.index ?? 0) + clauseMatch[0].lastIndexOf(aliasName)
          : (clauseMatch.index ?? 0);

      buffer.addOffset(
        importKeywordOffset + localOffset,
        declaredName.length,
        declaration.type,
        declaration.modifiers
      );
    }
  }

  const importMatcher = /^([ \t]*)import\b/gm;

  for (const match of maskedText.matchAll(importMatcher)) {
    const statementStart = match.index ?? 0;
    const statementEnd = findStatementEnd(maskedText, statementStart);
    const clauseOffset = statementStart + match[0].length;
    const clauseSource = maskedText.slice(clauseOffset, statementEnd);
    const clauseMatcher =
      /([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/g;

    for (const clauseMatch of clauseSource.matchAll(clauseMatcher)) {
      const namespaceName = clauseMatch[1];
      const aliasName = clauseMatch[2];
      if (!namespaceName) continue;

      const declarationOffset = clauseOffset + (clauseMatch.index ?? 0);
      addQualifiedNamespace(
        buffer,
        declarationOffset,
        namespaceName,
        aliasName ? [] : ["declaration"]
      );

      if (!aliasName) continue;

      buffer.addOffset(
        declarationOffset + clauseMatch[0].lastIndexOf(aliasName),
        aliasName.length,
        "namespace",
        ["declaration"]
      );
    }
  }
}

function collectPythonClassDefinitions(
  buffer: SemanticTokenBuffer,
  model: monaco.editor.ITextModel,
  maskedText: string,
  maskedLines: string[]
): PythonClassBlock[] {
  const classBlocks: PythonClassBlock[] = [];
  const classMatcher = /^([ \t]*)class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

  for (const match of maskedText.matchAll(classMatcher)) {
    const className = match[2];
    if (!className) continue;

    const matchOffset = match.index ?? 0;
    const startLine = getLineIndexFromOffset(model, maskedText, matchOffset);
    const nameOffset = matchOffset + match[0].lastIndexOf(className);
    buffer.addOffset(nameOffset, className.length, "class", ["declaration"]);

    const statementEnd = findStatementEnd(maskedText, matchOffset);
    const colonOffset = findTopLevelChar(maskedText, matchOffset, statementEnd, ":");
    const openParenOffset = maskedText.indexOf("(", nameOffset + className.length);
    let baseNames: string[] = [];

    if (
      openParenOffset >= 0 &&
      openParenOffset < statementEnd &&
      (colonOffset < 0 || openParenOffset < colonOffset)
    ) {
      const closeParenOffset = findMatchingBracket(maskedText, openParenOffset);
      if (closeParenOffset >= 0 && closeParenOffset < statementEnd) {
        const basesSource = maskedText.slice(openParenOffset + 1, closeParenOffset);
        baseNames = extractQualifiedNames(basesSource);
        collectTypeIdentifiers(
          buffer,
          basesSource,
          openParenOffset + 1
        );
      }
    }

    const headerEndLine = getLineIndexFromOffset(model, maskedText, statementEnd);
    const bodyStartLine = headerEndLine + 1;
    const indentWidth = getIndentWidth(match[1] || "");
    const bodyEndLine = findIndentedBlockEnd(
      maskedLines,
      bodyStartLine,
      indentWidth
    );
    const decorators = getDecoratorNamesForLine(maskedLines, startLine);

    classBlocks.push({
      decorators,
      startLine: bodyStartLine,
      endLine: bodyEndLine,
      framework: resolveClassFramework(decorators, baseNames),
      indent: indentWidth,
    });
  }

  return classBlocks;
}

function collectPythonFunctionDefinitions(
  buffer: SemanticTokenBuffer,
  model: monaco.editor.ITextModel,
  maskedText: string,
  maskedLines: string[],
  classBlocks: BlockRange[]
): BlockRange[] {
  const functionBlocks: BlockRange[] = [];
  const functionMatcher =
    /^([ \t]*)(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

  for (const match of maskedText.matchAll(functionMatcher)) {
    const functionName = match[3];
    if (!functionName) continue;

    const matchOffset = match.index ?? 0;
    const nameOffset = matchOffset + match[0].lastIndexOf(functionName);
    const openParenOffset = matchOffset + match[0].length - 1;
    const closeParenOffset = findMatchingBracket(maskedText, openParenOffset);
    if (closeParenOffset < 0) continue;

    const statementEnd = findStatementEnd(maskedText, matchOffset);
    const startLine = getLineIndexFromOffset(model, maskedText, matchOffset);
    const headerEndLine = getLineIndexFromOffset(model, maskedText, statementEnd);
    const bodyStartLine = headerEndLine + 1;
    const indentWidth = getIndentWidth(match[1] || "");
    const bodyEndLine = findIndentedBlockEnd(
      maskedLines,
      bodyStartLine,
      indentWidth
    );

    const parameterSource = maskedText.slice(openParenOffset + 1, closeParenOffset);
    const decorators = getDecoratorNamesForLine(maskedLines, startLine);
    const insideClass = lineInsideBlock(startLine, classBlocks);
    const isMethod =
      insideClass &&
      (decorators.some((decorator) => PYTHON_METHOD_DECORATORS.has(decorator)) ||
        /^(?:\s*\*{0,2})?(self|cls)\b/.test(parameterSource.trim()));

    const modifiers: TokenModifierName[] = ["declaration"];
    if (match[2]) modifiers.push("async");

    buffer.addOffset(
      nameOffset,
      functionName.length,
      isMethod ? "method" : "function",
      modifiers
    );

    collectPythonParameters(buffer, parameterSource, openParenOffset + 1);

    const arrowOffset = findTopLevelSequence(
      maskedText,
      closeParenOffset + 1,
      statementEnd,
      "->"
    );
    const colonOffset = findTopLevelChar(
      maskedText,
      closeParenOffset + 1,
      statementEnd,
      ":"
    );

    if (arrowOffset >= 0 && colonOffset > arrowOffset) {
      collectTypeIdentifiers(
        buffer,
        maskedText.slice(arrowOffset + 2, colonOffset),
        arrowOffset + 2
      );
    }

    functionBlocks.push({
      startLine: bodyStartLine,
      endLine: bodyEndLine,
      indent: indentWidth,
    });
  }

  return functionBlocks;
}

function collectPythonTypeAliases(
  buffer: SemanticTokenBuffer,
  maskedText: string
): void {
  const typeStatementMatcher = /^([ \t]*)type\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

  for (const match of maskedText.matchAll(typeStatementMatcher)) {
    const aliasName = match[2];
    if (!aliasName) continue;

    const matchOffset = match.index ?? 0;
    const nameOffset = matchOffset + match[0].lastIndexOf(aliasName);
    buffer.addOffset(nameOffset, aliasName.length, "type", ["declaration"]);

    const statementEnd = findStatementEnd(maskedText, matchOffset);
    const equalsOffset = findTopLevelChar(maskedText, matchOffset, statementEnd, "=");
    if (equalsOffset >= 0) {
      collectTypeIdentifiers(
        buffer,
        maskedText.slice(equalsOffset + 1, statementEnd),
        equalsOffset + 1
      );
    }
  }

  const annotatedAliasMatcher =
    /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*((?:[A-Za-z_][\w.]*\.)?TypeAlias)\s*=/gm;

  for (const match of maskedText.matchAll(annotatedAliasMatcher)) {
    const aliasName = match[2];
    const annotation = match[3];
    if (!aliasName || !annotation) continue;

    const matchOffset = match.index ?? 0;
    const nameOffset = matchOffset + match[0].indexOf(aliasName);
    const annotationOffset = matchOffset + match[0].indexOf(annotation);
    buffer.addOffset(nameOffset, aliasName.length, "type", ["declaration"]);
    collectTypeIdentifiers(buffer, annotation, annotationOffset);

    const statementEnd = findStatementEnd(maskedText, matchOffset);
    const equalsOffset = findTopLevelChar(maskedText, matchOffset, statementEnd, "=");
    if (equalsOffset >= 0) {
      collectTypeIdentifiers(
        buffer,
        maskedText.slice(equalsOffset + 1, statementEnd),
        equalsOffset + 1
      );
    }
  }
}

function collectPythonSpecialTypeFactories(
  buffer: SemanticTokenBuffer,
  rawText: string,
  maskedText: string
): void {
  const factoryMatcher =
    /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*((?:[A-Za-z_][A-Za-z0-9_]*\.)*(TypedDict|NamedTuple|Enum|Flag|IntEnum|IntFlag|ReprEnum|StrEnum))\s*\(/gm;

  for (const match of maskedText.matchAll(factoryMatcher)) {
    const declaredName = match[2];
    const factorySuffix = match[4];
    if (!declaredName || !factorySuffix) continue;

    const matchOffset = match.index ?? 0;
    const declaredNameOffset = matchOffset + match[0].indexOf(declaredName);
    buffer.addOffset(
      declaredNameOffset,
      declaredName.length,
      "class",
      ["declaration"]
    );

    const openParenOffset = matchOffset + match[0].length - 1;
    const closeParenOffset = findMatchingBracket(maskedText, openParenOffset);
    if (closeParenOffset < 0) continue;

    const argsOffset = openParenOffset + 1;
    const rawArgsSource = rawText.slice(argsOffset, closeParenOffset);
    const maskedArgsSource = maskedText.slice(argsOffset, closeParenOffset);
    if (!maskedArgsSource.trim()) continue;

    if (PYTHON_SPECIAL_TYPE_FACTORY_CALLS.has(factorySuffix)) {
      collectTypeIdentifiers(buffer, maskedArgsSource, argsOffset);
    }

    const args = getAlignedSegments(maskedArgsSource, rawArgsSource);
    if (args.length === 0) continue;

    addStringLiteralIdentifier(
      buffer,
      args[0].raw,
      argsOffset + args[0].start,
      "class",
      ["declaration"]
    );

    const memberArg = args[1];
    if (!memberArg) continue;

    if (factorySuffix === "TypedDict") {
      collectStringKeysInDictLiteral(
        buffer,
        memberArg.raw,
        memberArg.masked,
        argsOffset + memberArg.start,
        "property",
        ["declaration"]
      );
      continue;
    }

    if (factorySuffix === "NamedTuple") {
      if (parseStringLiteral(memberArg.raw)) {
        addStringLiteralIdentifiers(
          buffer,
          memberArg.raw,
          argsOffset + memberArg.start,
          "property",
          ["declaration", "readonly"]
        );
      } else {
        collectStringEntriesInSequence(
          buffer,
          memberArg.raw,
          memberArg.masked,
          argsOffset + memberArg.start,
          "property",
          ["declaration", "readonly"]
        );
      }
      continue;
    }

    if (parseStringLiteral(memberArg.raw)) {
      addStringLiteralIdentifiers(
        buffer,
        memberArg.raw,
        argsOffset + memberArg.start,
        "property",
        ["declaration", "readonly"]
      );
      continue;
    }

    collectStringKeysInDictLiteral(
      buffer,
      memberArg.raw,
      memberArg.masked,
      argsOffset + memberArg.start,
      "property",
      ["declaration", "readonly"]
    );
    collectStringEntriesInSequence(
      buffer,
      memberArg.raw,
      memberArg.masked,
      argsOffset + memberArg.start,
      "property",
      ["declaration", "readonly"]
    );
  }
}

function collectWithAliasesInSource(
  buffer: SemanticTokenBuffer,
  maskedSource: string,
  sourceOffset: number
): void {
  const withPrefixMatch = /^\s*(?:async\s+)?with\b/.exec(maskedSource);
  if (!withPrefixMatch) return;

  const clauseStart = withPrefixMatch[0].length;
  const clauseEnd = findTopLevelChar(
    maskedSource,
    clauseStart,
    maskedSource.length,
    ":"
  );
  if (clauseEnd < 0) return;

  const clauseSource = maskedSource.slice(clauseStart, clauseEnd);
  for (const segment of splitTopLevelSegments(clauseSource)) {
    const asOffset = findTopLevelSequence(
      segment.text,
      0,
      segment.text.length,
      " as "
    );
    if (asOffset < 0) continue;

    const aliasSource = segment.text.slice(asOffset + 4).trim();
    const aliasMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(aliasSource);
    if (!aliasMatch?.[1]) continue;

    const aliasOffsetInSegment = segment.text.indexOf(aliasMatch[1], asOffset + 4);
    if (aliasOffsetInSegment < 0) continue;

    buffer.addOffset(
      sourceOffset + clauseStart + segment.start + aliasOffsetInSegment,
      aliasMatch[1].length,
      "variable",
      ["declaration"]
    );
  }
}

function collectForTargetsInSource(
  buffer: SemanticTokenBuffer,
  maskedSource: string,
  sourceOffset: number
): void {
  const forPrefixMatch = /^\s*(?:async\s+)?for\b/.exec(maskedSource);
  if (!forPrefixMatch) return;

  const clauseStart = forPrefixMatch[0].length;
  const inOffset = findTopLevelSequence(
    maskedSource,
    clauseStart,
    maskedSource.length,
    " in "
  );
  if (inOffset < 0) return;

  const targetSource = maskedSource.slice(clauseStart, inOffset);
  collectAssignmentTargetPattern(
    buffer,
    targetSource,
    sourceOffset + clauseStart
  );
}

function collectWalrusBindingsInSource(
  buffer: SemanticTokenBuffer,
  maskedSource: string,
  sourceOffset: number
): void {
  const walrusMatcher = /(^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)\s*:=/g;

  for (const match of maskedSource.matchAll(walrusMatcher)) {
    const name = match[2];
    if (!name || name === "self" || name === "cls") continue;

    const nameOffset =
      sourceOffset + (match.index ?? 0) + match[0].lastIndexOf(name);
    const modifiers: TokenModifierName[] = ["declaration"];
    if (isReadonlyName(name)) {
      modifiers.push("readonly");
    }

    buffer.addOffset(nameOffset, name.length, "variable", modifiers);
  }
}

function collectPlainAssignmentBindingsInSource(
  buffer: SemanticTokenBuffer,
  maskedSource: string,
  sourceOffset: number
): void {
  const operatorOffsets = findTopLevelAssignmentOperators(maskedSource);
  if (operatorOffsets.length === 0) return;

  let segmentStart = 0;
  for (const operatorOffset of operatorOffsets) {
    const targetSource = maskedSource.slice(segmentStart, operatorOffset);
    collectAssignmentTargetPattern(
      buffer,
      targetSource,
      sourceOffset + segmentStart
    );
    segmentStart = operatorOffset + 1;
  }
}

function collectPythonStatementLevelBindings(
  buffer: SemanticTokenBuffer,
  model: monaco.editor.ITextModel,
  maskedText: string,
  classBlocks: PythonClassBlock[],
  functionBlocks: BlockRange[]
): void {
  let statementOffset = 0;

  while (statementOffset < maskedText.length) {
    const statementEnd = findStatementEnd(maskedText, statementOffset);
    const statementSource = maskedText.slice(statementOffset, statementEnd);

    if (statementSource.includes("\n") && statementSource.trim()) {
      const statementLine = getLineIndexFromOffset(
        model,
        maskedText,
        statementOffset
      );
      const classBodyLine =
        getContainingBlock(statementLine, classBlocks) !== null &&
        !lineInsideBlock(statementLine, functionBlocks);

      collectWithAliasesInSource(buffer, statementSource, statementOffset);
      collectForTargetsInSource(buffer, statementSource, statementOffset);

      if (!classBodyLine) {
        collectWalrusBindingsInSource(buffer, statementSource, statementOffset);
        collectPlainAssignmentBindingsInSource(
          buffer,
          statementSource,
          statementOffset
        );
      }
    }

    if (statementEnd >= maskedText.length) break;
    statementOffset = statementEnd + 1;
  }
}

function collectPythonLambdaParameters(
  buffer: SemanticTokenBuffer,
  maskedText: string
): void {
  const lambdaMatcher = /\blambda\b/g;

  for (const match of maskedText.matchAll(lambdaMatcher)) {
    const lambdaOffset = match.index ?? 0;
    const parametersOffset = lambdaOffset + match[0].length;
    const statementEnd = findStatementEnd(maskedText, lambdaOffset);
    const colonOffset = findTopLevelChar(
      maskedText,
      parametersOffset,
      statementEnd,
      ":"
    );
    if (colonOffset < 0) continue;

    collectPythonParameters(
      buffer,
      maskedText.slice(parametersOffset, colonOffset),
      parametersOffset
    );
  }
}

function collectPythonScopedBindings(
  buffer: SemanticTokenBuffer,
  maskedText: string
): void {
  let statementOffset = 0;

  while (statementOffset < maskedText.length) {
    const statementEnd = findStatementEnd(maskedText, statementOffset);
    const statementSource = maskedText.slice(statementOffset, statementEnd);
    const scopeMatch = /^\s*(?:global|nonlocal)\b/.exec(statementSource);

    if (scopeMatch) {
      collectAssignmentTargetPattern(
        buffer,
        statementSource.slice(scopeMatch[0].length),
        statementOffset + scopeMatch[0].length
      );
    }

    if (statementEnd >= maskedText.length) break;
    statementOffset = statementEnd + 1;
  }
}

function collectPythonComprehensionBindings(
  buffer: SemanticTokenBuffer,
  maskedText: string
): void {
  const bracketStack: Array<{ char: string; offset: number }> = [];

  for (let index = 0; index < maskedText.length; index += 1) {
    const char = maskedText[index];
    if (char === "(" || char === "[" || char === "{") {
      bracketStack.push({ char, offset: index });
      continue;
    }
    if (char !== ")" && char !== "]" && char !== "}") continue;

    const expectedOpen = char === ")" ? "(" : char === "]" ? "[" : "{";
    let openBracket: { char: string; offset: number } | undefined;

    while (bracketStack.length > 0) {
      const candidate = bracketStack.pop();
      if (candidate?.char === expectedOpen) {
        openBracket = candidate;
        break;
      }
    }

    if (!openBracket || openBracket.offset + 1 >= index) continue;

    const bodyOffset = openBracket.offset + 1;
    const bodySource = maskedText.slice(bodyOffset, index);
    if (!bodySource.includes("for")) continue;

    for (const forOffset of findTopLevelKeywordOffsets(bodySource, "for")) {
      const inOffset = findTopLevelSequence(
        bodySource,
        forOffset + 3,
        bodySource.length,
        " in "
      );
      if (inOffset < 0) continue;

      collectAssignmentTargetPattern(
        buffer,
        bodySource.slice(forOffset + 3, inOffset),
        bodyOffset + forOffset + 3
      );
    }
  }
}

function collectPythonCaseBindings(
  buffer: SemanticTokenBuffer,
  maskedText: string
): void {
  const caseMatcher = /^([ \t]*)case\b/gm;

  for (const match of maskedText.matchAll(caseMatcher)) {
    const statementStart = match.index ?? 0;
    const patternOffset = statementStart + match[0].length;
    const statementEnd = findStatementEnd(maskedText, statementStart);
    const colonOffset = findTopLevelChar(
      maskedText,
      patternOffset,
      statementEnd,
      ":"
    );
    if (colonOffset < 0) continue;

    const guardOffset = findTopLevelSequence(
      maskedText,
      patternOffset,
      colonOffset,
      " if "
    );
    const patternEnd = guardOffset >= 0 ? guardOffset : colonOffset;
    const patternSource = maskedText.slice(patternOffset, patternEnd);
    const captureMatcher = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

    for (const captureMatch of patternSource.matchAll(captureMatcher)) {
      const captureName = captureMatch[1];
      if (!captureName) continue;

      const relativeOffset = captureMatch.index ?? 0;
      if (
        !shouldCaptureCasePatternName(
          patternSource,
          relativeOffset,
          captureName
        )
      ) {
        continue;
      }

      buffer.addOffset(
        patternOffset + relativeOffset,
        captureName.length,
        "variable",
        ["declaration"]
      );
    }
  }
}

function collectPythonLineLevelTokens(
  buffer: SemanticTokenBuffer,
  model: monaco.editor.ITextModel,
  maskedLines: string[],
  classBlocks: PythonClassBlock[],
  functionBlocks: BlockRange[]
): void {
  maskedLines.forEach((maskedLine, lineIndex) => {
    const trimmed = maskedLine.trim();
    if (!trimmed) return;

    const lineOffset = getLineStartOffset(model, lineIndex);
    const classBlock = getContainingBlock(lineIndex, classBlocks);
    const classBodyLine =
      classBlock !== null && !lineInsideBlock(lineIndex, functionBlocks);

    const propertyAnnotationMatcher =
      /\b(?:self|cls)\.([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=]+?)(?:\s*=|$)/;
    const propertyAnnotationMatch = propertyAnnotationMatcher.exec(maskedLine);
    if (propertyAnnotationMatch?.[1]) {
      const propertyName = propertyAnnotationMatch[1];
      const annotationSource = propertyAnnotationMatch[2]?.trim() || "";
      const propertyOffset =
        lineOffset +
        (propertyAnnotationMatch.index ?? 0) +
        propertyAnnotationMatch[0].indexOf(propertyName);

      buffer.addOffset(
        propertyOffset,
        propertyName.length,
        "property",
        ["declaration"]
      );

      if (annotationSource) {
        const annotationOffsetInMatch =
          propertyAnnotationMatch[0].indexOf(annotationSource);
        if (annotationOffsetInMatch >= 0) {
          collectTypeIdentifiers(
            buffer,
            annotationSource,
            lineOffset +
              (propertyAnnotationMatch.index ?? 0) +
              annotationOffsetInMatch
          );
        }
      }
    }

    const propertyAssignmentMatcher =
      /\b(?:self|cls)\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    for (const match of maskedLine.matchAll(propertyAssignmentMatcher)) {
      const propertyName = match[1];
      if (!propertyName) continue;

      const propertyOffset =
        lineOffset + (match.index ?? 0) + match[0].indexOf(propertyName);
      buffer.addOffset(
        propertyOffset,
        propertyName.length,
        "property",
        ["declaration"]
      );
    }

    if (!/^(class|def|async\s+def|from\s|import\s|type\s)/.test(trimmed)) {
      const annotatedNameMatcher =
        /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=]+?)(?:\s*=|$)/;
      const annotatedNameMatch = annotatedNameMatcher.exec(maskedLine);
      if (annotatedNameMatch?.[2]) {
        const name = annotatedNameMatch[2];
        const annotationSource = annotatedNameMatch[3]?.trim() || "";
        const nameOffset = lineOffset + annotatedNameMatch[0].indexOf(name);
        const classVariable = isClassVarAnnotation(annotationSource);
        const tokenType: TokenTypeName =
          classBodyLine && !classVariable ? "property" : "variable";
        const modifiers: TokenModifierName[] = ["declaration"];

        if (
          (!classBodyLine || classVariable) &&
          (isReadonlyName(name) || isFinalAnnotation(annotationSource))
        ) {
          modifiers.push("readonly");
        }

        if (
          classBodyLine &&
          !classVariable &&
          (classBlock?.framework === "namedTuple" ||
            classBlock?.framework === "enum")
        ) {
          modifiers.push("readonly");
        }

        buffer.addOffset(nameOffset, name.length, tokenType, modifiers);

        if (annotationSource) {
          const annotationOffsetInMatch =
            annotatedNameMatch[0].indexOf(annotationSource);
          if (annotationOffsetInMatch >= 0) {
            collectTypeIdentifiers(
              buffer,
              annotationSource,
              lineOffset + annotationOffsetInMatch
            );
          }
        }
      }
    }

    if (classBodyLine && !/^(class|def|async\s+def|from\s|import\s|type\s)/.test(trimmed)) {
      const assignedNameMatcher =
        /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/;
      const assignedNameMatch = assignedNameMatcher.exec(maskedLine);

      if (assignedNameMatch?.[2] && assignedNameMatch[3]) {
        const name = assignedNameMatch[2];
        const expressionSource = assignedNameMatch[3].trim();
        const nameOffset = lineOffset + assignedNameMatch[0].indexOf(name);
        const callName = getLeadingCallName(expressionSource);
        const fieldFactoryCall =
          callName !== null && isKnownFieldFactoryCall(callName, classBlock);
        const pydanticConfigLine =
          classBlock?.framework === "pydantic" &&
          name === "model_config" &&
          (callName === "ConfigDict" || callName === "pydantic.ConfigDict");
        const enumMemberLine =
          classBlock?.framework === "enum" && !name.startsWith("_");

        if (fieldFactoryCall || pydanticConfigLine || enumMemberLine) {
          const modifiers: TokenModifierName[] = ["declaration"];

          if (pydanticConfigLine || enumMemberLine || isReadonlyName(name)) {
            modifiers.push("readonly");
          }

          buffer.addOffset(
            nameOffset,
            name.length,
            fieldFactoryCall || enumMemberLine ? "property" : "variable",
            modifiers
          );
        }
      }
    }

    const constantMatcher = /^([ \t]*)([A-Z][A-Z0-9_]*)\s*=/;
    const constantMatch = constantMatcher.exec(maskedLine);
    if (constantMatch?.[2]) {
      const name = constantMatch[2];
      const nameOffset = lineOffset + constantMatch[0].indexOf(name);
      const modifiers: TokenModifierName[] = classBodyLine
        ? ["declaration"]
        : ["declaration", "readonly"];

      if (
        classBodyLine &&
        (classBlock?.framework === "enum" ||
          classBlock?.framework === "namedTuple")
      ) {
        modifiers.push("readonly");
      }

      buffer.addOffset(
        nameOffset,
        name.length,
        classBodyLine ? "property" : "variable",
        modifiers
      );
    }

    const exceptAliasMatcher =
      /^\s*except\*?(?:\s+[^:]+)?\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/;
    const exceptAliasMatch = exceptAliasMatcher.exec(maskedLine);
    if (exceptAliasMatch?.[1]) {
      const aliasName = exceptAliasMatch[1];
      buffer.addOffset(
        lineOffset + exceptAliasMatch[0].lastIndexOf(aliasName),
        aliasName.length,
        "variable",
        ["declaration"]
      );
    }

    if (!classBodyLine) {
      collectWalrusBindingsInSource(buffer, maskedLine, lineOffset);
      collectPlainAssignmentBindingsInSource(buffer, maskedLine, lineOffset);
    }

    collectWithAliasesInSource(buffer, maskedLine, lineOffset);
    collectForTargetsInSource(buffer, maskedLine, lineOffset);

    for (const match of maskedLine.matchAll(
      /\b(?:self|cls)\.([A-Za-z_][A-Za-z0-9_]*)\b/g
    )) {
      const propertyName = match[1];
      if (!propertyName) continue;

      const propertyOffset =
        lineOffset + (match.index ?? 0) + match[0].lastIndexOf(propertyName);
      buffer.addOffset(propertyOffset, propertyName.length, "property");
    }

    for (const match of maskedLine.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const methodName = match[1];
      if (!methodName) continue;

      buffer.addOffset(
        lineOffset + (match.index ?? 0) + 1,
        methodName.length,
        "method"
      );
    }

    for (const match of maskedLine.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const callName = match[1];
      if (!callName || PYTHON_CALL_EXCLUSIONS.has(callName)) continue;

      const relativeOffset = match.index ?? 0;
      if (relativeOffset > 0 && maskedLine[relativeOffset - 1] === ".") continue;

      buffer.addOffset(
        lineOffset + relativeOffset,
        callName.length,
        /^[A-Z][A-Za-z0-9_]*$/.test(callName) ? "class" : "function"
      );
    }
  });
}

function tokenizePythonModel(model: monaco.editor.ITextModel): Uint32Array {
  const rawText = model.getValue();
  const protectedRanges = buildProtectedRanges(model);
  const buffer = new SemanticTokenBuffer(model, protectedRanges);
  const rawLines = model.getLinesContent();
  const maskedLines = rawLines.map((line, lineIndex) =>
    maskLine(line, protectedRanges.get(lineIndex) || [])
  );
  const maskedText = maskedLines.join("\n");

  collectDecorators(buffer, maskedText);
  collectPythonImports(buffer, maskedText);
  collectPythonTypeAliases(buffer, maskedText);
  collectPythonSpecialTypeFactories(buffer, rawText, maskedText);
  collectPythonCaseBindings(buffer, maskedText);
  collectPythonLambdaParameters(buffer, maskedText);
  collectPythonScopedBindings(buffer, maskedText);
  collectPythonComprehensionBindings(buffer, maskedText);

  const classBlocks = collectPythonClassDefinitions(
    buffer,
    model,
    maskedText,
    maskedLines
  );
  const functionBlocks = collectPythonFunctionDefinitions(
    buffer,
    model,
    maskedText,
    maskedLines,
    classBlocks
  );

  collectPythonStatementLevelBindings(
    buffer,
    model,
    maskedText,
    classBlocks,
    functionBlocks
  );
  collectPythonLineLevelTokens(
    buffer,
    model,
    maskedLines,
    classBlocks,
    functionBlocks
  );

  return buffer.encode();
}

function createPythonSemanticTokensProvider(): monaco.languages.DocumentSemanticTokensProvider {
  const legend: monaco.languages.SemanticTokensLegend = {
    tokenTypes: [...TOKEN_TYPES],
    tokenModifiers: [...TOKEN_MODIFIERS],
  };

  return {
    getLegend: () => legend,
    provideDocumentSemanticTokens(model) {
      return {
        data: tokenizePythonModel(model),
      };
    },
    releaseDocumentSemanticTokens() {},
  };
}

let semanticProvidersRegistered = false;

export function registerSemanticTokensProviders(): void {
  if (semanticProvidersRegistered) return;
  semanticProvidersRegistered = true;

  monaco.languages.registerDocumentSemanticTokensProvider(
    "python",
    createPythonSemanticTokensProvider()
  );
}
