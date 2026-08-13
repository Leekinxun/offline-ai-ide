import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "scripts/fixtures/ws14-release-contract.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const reportOnly = process.argv.includes("--report");
const failures = [];
const require = createRequire(import.meta.url);
const ts = require(path.join(root, "frontend/node_modules/typescript/lib/typescript.js"));

function fail(id, message) { failures.push({ id, message }); }
function absolute(relative) { return path.join(root, relative); }
function read(relative, id = relative) {
  try { return fs.readFileSync(absolute(relative), "utf8"); }
  catch { fail(id, `missing readable file: ${relative}`); return ""; }
}
function requireTokens(source, required, id) {
  for (const token of required) if (!source.includes(token)) fail(id, `missing ${JSON.stringify(token)}`);
}
function walk(directory, extension) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...walk(target, extension));
    else if (entry.isFile() && target.endsWith(extension)) results.push(target);
  }
  return results;
}
function jsxAttribute(opening, name) {
  return opening.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === name);
}
function expressionDependencies(sourceAst, expression) {
  const declarations = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(sourceAst);
  const dependencies = new Set(); const resolving = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      dependencies.add(node.text);
      const initializer = declarations.get(node.text);
      if (initializer && !resolving.has(node.text)) { resolving.add(node.text); visit(initializer); resolving.delete(node.text); }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return dependencies;
}
function importsNamedSymbol(sourceAst, modulePath, symbol) {
  return sourceAst.statements.some((statement) =>
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === modulePath
    && statement.importClause?.namedBindings
    && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some((element) => element.name.text === symbol),
  );
}
function callsCloseCallback(sourceAst, functionName) {
  let found = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === functionName && node.arguments.length >= 2) {
      const callback = node.arguments[1];
      if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && /\bonClose(?:Ref)?\b/.test(callback.getText(sourceAst))) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceAst);
  return found;
}

const modalEscapeFile = "frontend/src/components/modalKeyboardContract.ts";
const modalEscapeSource = read(modalEscapeFile, "modal-escape-contract");
const modalEscapeAst = ts.createSourceFile(modalEscapeFile, modalEscapeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let auditedModalEscapeContract = false;
for (const statement of modalEscapeAst.statements) {
  if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== "claimModalEscape" || !statement.body) continue;
  const body = statement.body.getText(modalEscapeAst);
  auditedModalEscapeContract = /event\.key\s*!==\s*["']Escape["']/.test(body)
    && /event\.preventDefault\s*\(\s*\)/.test(body)
    && /event\.stopImmediatePropagation\s*\(\s*\)/.test(body)
    && /onClose\s*\(\s*\)/.test(body)
    && /return\s+true\b/.test(body);
}
if (!auditedModalEscapeContract) fail("modal-escape-contract", `${modalEscapeFile} must claim Escape, prevent its default, stop later modal listeners, close the topmost modal, and return true`);

const modalFocusFile = "frontend/src/components/useModalDialogFocus.ts";
const modalFocusSource = read(modalFocusFile, "modal-focus-contract");
const modalFocusAst = ts.createSourceFile(modalFocusFile, modalFocusSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const auditedModalFocusEscapeContract = auditedModalEscapeContract
  && importsNamedSymbol(modalFocusAst, "./modalKeyboardContract", "claimModalEscape")
  && callsCloseCallback(modalFocusAst, "claimModalEscape");
if (!auditedModalFocusEscapeContract) fail("modal-focus-contract", `${modalFocusFile} must import the audited Escape contract and delegate it to onClose`);

if (fixture.schemaVersion !== 1) fail("fixture", "unsupported fixture schemaVersion");
const verificationFiles = fixture.verificationEntry.files || [fixture.verificationEntry.file];
const verificationSource = verificationFiles.map((file) => read(file, "verification-entry")).join("\n");
requireTokens(verificationSource, fixture.verificationEntry.required, "verification-entry");

const frontendFiles = walk(absolute("frontend/src"), ".tsx");
for (const file of frontendFiles) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  const sourceAst = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const pattern of fixture.forbiddenFrontendPatterns) {
    let cursor = source.indexOf(pattern);
    while (cursor >= 0) {
      const line = source.slice(0, cursor).split("\n").length;
      fail("native-dialog", `${relative}:${line} contains ${JSON.stringify(pattern)}`);
      cursor = source.indexOf(pattern, cursor + pattern.length);
    }
  }
  const dialogTags = [...source.matchAll(/<[^<>]*\brole="(dialog|alertdialog)"[^<>]*>/gs)];
  for (const match of dialogTags) {
    const tag = match[0];
    const line = source.slice(0, match.index).split("\n").length;
    if (!/aria-(?:label|labelledby)=/.test(tag)) fail("dialog-name", `${relative}:${line} dialog has no accessible name`);
    if (!tag.includes("aria-modal=")) fail("dialog-modal", `${relative}:${line} dialog has no explicit modality`);
    if (match[1] === "alertdialog" && !tag.includes('aria-modal="true"')) fail("dialog-modal", `${relative}:${line} alertdialog is not modal`);
  }
  for (const match of source.matchAll(/<[^<>]*\bclassName="([^"]+)"[^<>]*>/gs)) {
    const classes = match[1].split(/\s+/);
    if (!classes.some((className) => className === "dialog" || className.endsWith("-dialog"))) continue;
    const line = source.slice(0, match.index).split("\n").length;
    if (!/\brole="(?:dialog|alertdialog)"/.test(match[0])) fail("dialog-role", `${relative}:${line} dialog-styled element has no dialog role`);
  }
  if (dialogTags.some((match) => match[0].includes('aria-modal="true"'))) {
    const usesSharedModalFocusContract = source.includes("useModalDialogFocus");
    const usesAuditedModalEscapeContract = auditedModalEscapeContract
      && importsNamedSymbol(sourceAst, "./modalKeyboardContract", "claimModalEscape")
      && callsCloseCallback(sourceAst, "claimModalEscape");
    const keyboardEvidence = [
      { label: "Escape handling", present: (usesSharedModalFocusContract && auditedModalFocusEscapeContract) || usesAuditedModalEscapeContract || /event\.key\s*[!=]==?\s*["']Escape["']/.test(source) },
      { label: "Tab handling", present: usesSharedModalFocusContract || /event\.key\s*[!=]==?\s*["']Tab["']/.test(source) },
      { label: "focusable-element discovery", present: usesSharedModalFocusContract || source.includes("querySelectorAll<HTMLElement>") },
      { label: "active-element tracking", present: usesSharedModalFocusContract || source.includes("document.activeElement") },
      { label: "programmatic focus", present: usesSharedModalFocusContract || source.includes(".focus()") },
    ];
    for (const evidence of keyboardEvidence) {
      if (!evidence.present) fail("dialog-keyboard", `${relative} modal dialog is missing ${evidence.label}`);
    }
    if (/event\.key\s*!==\s*["']Tab["']\s*\|\|[^\n]*(?:confirmation|passwordTarget)/.test(source) && !source.includes("useModalDialogFocus")) {
      fail("dialog-keyboard", `${relative} disables the parent focus trap while a nested modal is open without a separate shared focus contract`);
    }
  }
}

const modalDrawerStates = [];
for (const drawer of fixture.conditionalModalDrawers) {
  const source = read(drawer.file, drawer.id);
  const conditionalDialog = /role=\{[^}]*["']dialog["']/s.test(source);
  const conditionalModal = /aria-modal=\{[^}]+\}/s.test(source);
  if (!conditionalDialog) fail(drawer.id, "compact drawer must expose conditional dialog semantics");
  if (!conditionalModal) fail(drawer.id, "compact drawer must expose conditional aria-modal semantics");
  if (!source.includes("useModalDialogFocus")) fail(drawer.id, "modal drawer has no shared focus-trap/return-focus contract");
  if (!/open:\s*(?:visible\s*&&\s*)?drawerMode/.test(source)) fail(drawer.id, "modal drawer focus contract is not gated by drawerMode");
  modalDrawerStates.push(drawer.openState);
}
{
  const appFile = "frontend/src/App.tsx"; const appSource = read(appFile, "compact-modal-inert");
  const appAst = ts.createSourceFile(appFile, appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const inertDependencies = [];
  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement; const marker = jsxAttribute(opening, "data-compact-modal-background"); const inert = jsxAttribute(opening, "inert");
      if (marker && inert?.initializer && ts.isJsxExpression(inert.initializer) && inert.initializer.expression) {
        const nestedDrawers = new Set();
        const inspect = (child) => {
          if ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child))) {
            const childOpening = ts.isJsxElement(child) ? child.openingElement : child;
            if (ts.isIdentifier(childOpening.tagName) && ["AgentBoard", "TeamPanel", "GitPanel", "Terminal"].includes(childOpening.tagName.text)) nestedDrawers.add(childOpening.tagName.text);
          }
          ts.forEachChild(child, inspect);
        };
        inspect(node);
        if (nestedDrawers.size) fail("compact-modal-inert", `background inert boundary contains modal drawer component(s): ${[...nestedDrawers].join(", ")}`);
        inertDependencies.push(expressionDependencies(appAst, inert.initializer.expression));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(appAst);
  for (const state of modalDrawerStates) {
    if (!inertDependencies.some((dependencies) => dependencies.has("compactWorkspace") && dependencies.has(state))) fail("compact-modal-inert", `no background inert boundary is tied to compactWorkspace and ${state}`);
  }
}

{
  const treeSource = read("frontend/src/components/FileTree.tsx", "file-tree-roving");
  requireTokens(treeSource, ["resolveVisibleTreeIndex", "effectiveRovingPath === node.path", "onRovingPathChange", "data-tree-path", "aria-keyshortcuts=\"Alt+D Control+Space\""], "file-tree-roving");
  if (treeSource.includes("hasActiveNode")) fail("file-tree-roving", "collapsed descendants must not remove the visible root tab stop");
  if ((treeSource.match(/tabIndex=\{-1\}/g) || []).length < 2) fail("file-tree-roving", "nested checkbox and action controls must not add extra tree tab stops");
}

{
  requireTokens(read("frontend/src/components/ChatPanel.tsx", "approval-next-action"), ["approvalStackRef", "scrollIntoView", "querySelector<HTMLElement>('button:not(:disabled)')"], "approval-next-action");
  requireTokens(read("frontend/src/components/ToolApprovalStack.tsx", "approval-next-action"), ["forwardRef<HTMLElement", "tabIndex={-1}"], "approval-next-action");
}

{
  const settingsFile = "frontend/src/components/SettingsModal.tsx"; const settingsSource = read(settingsFile, "settings-nested-modal");
  const settingsAst = ts.createSourceFile(settingsFile, settingsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let parentFound = false;
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      const className = jsxAttribute(node, "className"); const role = jsxAttribute(node, "role");
      if (className?.initializer && ts.isStringLiteral(className.initializer) && className.initializer.text.split(/\s+/).includes("settings-modal") && role?.initializer && ts.isStringLiteral(role.initializer) && role.initializer.text === "dialog") {
        parentFound = true;
        for (const name of ["inert", "aria-hidden"]) {
          const attribute = jsxAttribute(node, name);
          if (!attribute?.initializer || !ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) { fail("settings-nested-modal", `parent Settings dialog is missing ${name} while child modals are possible`); continue; }
          const dependencies = expressionDependencies(settingsAst, attribute.initializer.expression);
          for (const state of ["passwordTarget", "confirmation"]) if (!dependencies.has(state)) fail("settings-nested-modal", `parent Settings ${name} is not tied to ${state}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(settingsAst);
  if (!parentFound) fail("settings-nested-modal", "parent Settings dialog was not found");
}

{
  const treeFile = "frontend/src/components/FileTree.tsx"; const treeSource = read(treeFile, "file-tree-structure");
  const treeAst = ts.createSourceFile(treeFile, treeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const interactive = new Set(["a", "button", "input", "select", "textarea"]);
  const tagName = (opening) => ts.isIdentifier(opening.tagName) ? opening.tagName.text : "";
  const isMinusOne = (attribute) => attribute?.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression && ts.isPrefixUnaryExpression(attribute.initializer.expression) && attribute.initializer.expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(attribute.initializer.expression.operand) && attribute.initializer.expression.operand.text === "1";
  const inspectTreeItem = (element) => {
    const inspect = (node) => {
      if (node !== element && ts.isJsxElement(node)) {
        const nestedRole = jsxAttribute(node.openingElement, "role");
        if (nestedRole?.initializer && ts.isStringLiteral(nestedRole.initializer) && nestedRole.initializer.text === "treeitem") return;
      }
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (node !== element && interactive.has(tagName(opening)) && !isMinusOne(jsxAttribute(opening, "tabIndex"))) {
          const line = treeAst.getLineAndCharacterOfPosition(opening.getStart()).line + 1;
          fail("file-tree-nested-tabstop", `${treeFile}:${line} interactive descendant of treeitem must use tabIndex={-1}`);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(element);
  };
  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const role = jsxAttribute(node.openingElement, "role");
      if (role?.initializer && ts.isStringLiteral(role.initializer) && role.initializer.text === "treeitem") inspectTreeItem(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(treeAst);
  if (!fs.existsSync(absolute("scripts/fileTreeNavigation.test.ts"))) fail("file-tree-navigation-test", "missing browserless visible-tree navigation test");
}

for (const contract of fixture.componentContracts) requireTokens(read(contract.file, contract.id), contract.required, contract.id);

let coreEnglishMessages = new Map();
const localeSource = read(fixture.locale.file, "locale");
if (localeSource) {
  const localeAst = ts.createSourceFile(fixture.locale.file, localeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const diagnostic of localeAst.parseDiagnostics) fail("locale-parse", `${fixture.locale.file}:${diagnostic.start ?? 0} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  const dictionary = (exportName) => {
    let object;
    for (const statement of localeAst.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName || !declaration.initializer) continue;
        let initializer = declaration.initializer;
        while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
        if (ts.isObjectLiteralExpression(initializer)) object = initializer;
      }
    }
    const result = new Map(); const duplicates = [];
    if (!object) { fail("locale", `could not locate object export ${exportName}`); return { result, duplicates }; }
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || (!ts.isStringLiteral(property.name) && !ts.isIdentifier(property.name))) {
        fail("locale-static", `${exportName} contains a non-static property`); continue;
      }
      const key = property.name.text;
      const value = property.initializer;
      if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
        fail("locale-static", `${exportName}.${key} is not a static string`); continue;
      }
      if (result.has(key)) duplicates.push(key);
      result.set(key, value.text);
    }
    return { result, duplicates };
  };
  const en = dictionary(fixture.locale.englishExport);
  const zh = dictionary(fixture.locale.chineseExport);
  coreEnglishMessages = en.result;
  if (en.result.size < fixture.locale.minimumKeys) fail("locale-size", `English dictionary has ${en.result.size} keys; expected at least ${fixture.locale.minimumKeys}`);
  if (zh.result.size < fixture.locale.minimumKeys) fail("locale-size", `Chinese dictionary has ${zh.result.size} keys; expected at least ${fixture.locale.minimumKeys}`);
  for (const key of en.duplicates) fail("locale-duplicate", `English key is duplicated: ${key}`);
  for (const key of zh.duplicates) fail("locale-duplicate", `Chinese key is duplicated: ${key}`);
  for (const key of en.result.keys()) if (!zh.result.has(key)) fail("locale-missing-zh", key);
  for (const key of zh.result.keys()) if (!en.result.has(key)) fail("locale-missing-en", key);
  const placeholders = (value) => [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]).sort();
  for (const [key, value] of en.result) {
    if (!zh.result.has(key)) continue;
    if (!value.trim()) fail("locale-empty", `English value is empty: ${key}`);
    if (!zh.result.get(key).trim()) fail("locale-empty", `Chinese value is empty: ${key}`);
    const left = placeholders(value); const right = placeholders(zh.result.get(key));
    if (JSON.stringify(left) !== JSON.stringify(right)) fail("locale-placeholders", `${key}: en=${left.join(",")} zh=${right.join(",")}`);
  }
  const localizedSources = [...walk(absolute("frontend/src"), ".ts"), ...walk(absolute("frontend/src"), ".tsx")]
    .filter((file) => !file.includes(`${path.sep}plugins${path.sep}`) && file !== absolute(fixture.locale.file));
  const unknownLocaleUses = new Map();
  for (const file of localizedSources) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    const sourceAst = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments.length) {
        const key = node.arguments[0];
        if ((ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && !en.result.has(key.text)) {
          const files = unknownLocaleUses.get(key.text) ?? new Set(); files.add(relative); unknownLocaleUses.set(key.text, files);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceAst);
  }
  for (const [key, files] of unknownLocaleUses) fail("locale-unknown-key", `${key} used by ${[...files].join(", ")}`);
}

for (const file of [...walk(absolute("frontend/src/plugins"), ".ts"), ...walk(absolute("frontend/src/plugins"), ".tsx")]) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  const sourceAst = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bundles = new Map(); const usedKeys = new Set();
  const propertyName = (property) => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments.length) {
      const key = node.arguments[0]; if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) usedKeys.add(key.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "registerLocaleBundle" && node.arguments.length && ts.isObjectLiteralExpression(node.arguments[0])) {
      const object = node.arguments[0];
      const localeProperty = object.properties.find((property) => propertyName(property) === "locale");
      const messagesProperty = object.properties.find((property) => propertyName(property) === "messages");
      if (!localeProperty || !ts.isPropertyAssignment(localeProperty) || !ts.isStringLiteral(localeProperty.initializer) || !messagesProperty || !ts.isPropertyAssignment(messagesProperty) || !ts.isObjectLiteralExpression(messagesProperty.initializer)) {
        fail("plugin-locale-static", `${relative} has a non-static locale bundle`);
      } else {
        const locale = localeProperty.initializer.text; const messages = bundles.get(locale) ?? new Map();
        for (const property of messagesProperty.initializer.properties) {
          if (!ts.isPropertyAssignment(property) || (!ts.isStringLiteral(property.name) && !ts.isIdentifier(property.name)) || (!ts.isStringLiteral(property.initializer) && !ts.isNoSubstitutionTemplateLiteral(property.initializer))) {
            fail("plugin-locale-static", `${relative} ${locale} contains a non-static message`); continue;
          }
          const key = property.name.text;
          if (messages.has(key)) fail("plugin-locale-duplicate", `${relative} ${locale} duplicates ${key}`);
          if (!property.initializer.text.trim()) fail("plugin-locale-empty", `${relative} ${locale} has an empty ${key}`);
          messages.set(key, property.initializer.text);
        }
        bundles.set(locale, messages);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceAst);
  if (!bundles.size) continue;
  const en = bundles.get("en"); const zh = bundles.get("zh-CN");
  if (!en) fail("plugin-locale-missing-en", relative);
  if (!zh) fail("plugin-locale-missing-zh", relative);
  if (en && zh) {
    const placeholders = (value) => [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of en) {
      if (!zh.has(key)) { fail("plugin-locale-missing-zh", `${relative} ${key}`); continue; }
      const left = placeholders(value); const right = placeholders(zh.get(key));
      if (JSON.stringify(left) !== JSON.stringify(right)) fail("plugin-locale-placeholders", `${relative} ${key}: en=${left.join(",")} zh=${right.join(",")}`);
    }
    for (const key of zh.keys()) if (!en.has(key)) fail("plugin-locale-missing-en", `${relative} ${key}`);
    for (const key of usedKeys) if (!en.has(key) && !coreEnglishMessages.has(key)) fail("plugin-locale-unknown-key", `${relative} uses ${key}`);
  }
}

const css = read("frontend/src/App.css", "responsive-css");
for (const baseline of fixture.responsiveBaselines) {
  requireTokens(read(baseline.component, baseline.id), baseline.componentTokens, baseline.id);
  requireTokens(css, baseline.cssTokens, baseline.id);
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1]; offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}
for (const baseline of fixture.recordedVisualBaselines) {
  let bytes;
  try { bytes = fs.readFileSync(absolute(baseline.file)); }
  catch { fail("visual-baseline", `missing ${baseline.file}`); continue; }
  if (bytes.length < 10_000) fail("visual-baseline", `${baseline.file} is too small to be a recorded UI baseline`);
  const dimensions = jpegDimensions(bytes);
  if (!dimensions || dimensions.width !== baseline.width || dimensions.height !== baseline.height) fail("visual-baseline", `${baseline.file} expected ${baseline.width}x${baseline.height}, got ${dimensions ? `${dimensions.width}x${dimensions.height}` : "invalid JPEG"}`);
}

for (const document of fixture.documentation) {
  const source = read(document.file, document.id);
  if (source) {
    const normalized = source.toLowerCase();
    requireTokens(normalized, document.required.map((token) => token.toLowerCase()), document.id);
    for (const pattern of fixture.forbiddenDocumentationPatterns || []) {
      if (normalized.includes(pattern.toLowerCase())) fail(document.id, `contains stale documentation contract ${JSON.stringify(pattern)}`);
    }
  }
}
for (const surface of fixture.migrationSurfaces) {
  for (const file of [...surface.implementation, ...surface.tests]) if (!fs.existsSync(absolute(file))) fail(`migration-${surface.id}`, `missing evidence file ${file}`);
}
const migrationSource = read("backend/src/persistence/migrations.ts", "migration-inventory");
const inventoryBlock = migrationSource.slice(migrationSource.indexOf("MATERIAL_PERSISTENCE_INVENTORY"), migrationSource.indexOf("] as const", migrationSource.indexOf("MATERIAL_PERSISTENCE_INVENTORY")));
const inventoryIds = [...inventoryBlock.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((match) => match[1]);
if (inventoryIds.length === 0) fail("migration-inventory", "no material persistence formats were discovered");
const migrationGuide = read("docs/migrations/storage-migrations.md", "migration-inventory-docs");
if (migrationGuide) for (const id of inventoryIds) if (!migrationGuide.includes(`\`${id}\``)) fail("migration-inventory-docs", `missing inventory entry \`${id}\``);

if (failures.length) {
  process.stderr.write(`WS-14 release contract found ${failures.length} gap(s):\n`);
  for (const item of failures) process.stderr.write(`- [${item.id}] ${item.message}\n`);
  if (!reportOnly) process.exitCode = 1;
} else {
  process.stdout.write("CrewForge WS-14 release contract passed.\n");
}
