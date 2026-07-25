import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson,
  FoldVertical,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  Redo2,
  Search,
  Trash2,
  Undo2,
  UnfoldVertical,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { derivePluginScopes } from "../permissions";
import type { BuiltinPluginDefinition } from "../types";
import {
  addJsonChild,
  deleteJsonNode,
  formatJson,
  renameJsonKey,
  replaceJsonNode,
  type JsonNodePath,
  type JsonPrimitive,
  type JsonValue,
} from "./jsonTree";

interface JsonStats {
  arrays: number;
  objects: number;
  primitives: number;
  total: number;
}

interface JsonNodeProps {
  value: JsonValue;
  nodeKey?: string | number;
  path: string;
  nodePath: JsonNodePath;
  depth: number;
  collapsed: Set<string>;
  matchedPaths: Set<string>;
  visiblePaths: Set<string>;
  queryActive: boolean;
  ancestorMatched?: boolean;
  copiedTarget: string | null;
  canModify: boolean;
  onToggle: (path: string) => void;
  onCopy: (target: string, value: string) => void;
  onAdd: (path: JsonNodePath, displayPath: string, value: JsonValue) => void;
  onEdit: (path: JsonNodePath, displayPath: string, value: JsonValue) => void;
  onRename: (path: JsonNodePath, displayPath: string, key: string) => void;
  onDelete: (path: JsonNodePath, displayPath: string) => void;
}

type JsonDraftType = "string" | "number" | "boolean" | "null" | "object" | "array";

type JsonEditorAction =
  | { kind: "add"; path: JsonNodePath; displayPath: string; parent: JsonValue }
  | { kind: "edit"; path: JsonNodePath; displayPath: string; value: JsonValue }
  | { kind: "rename"; path: JsonNodePath; displayPath: string; currentKey: string }
  | { kind: "delete"; path: JsonNodePath; displayPath: string };

interface JsonMutationDraft {
  key?: string;
  value?: JsonValue;
}

const permissions = ["editor.preview", "editor.modify", "ui.messages"] as const;
const HISTORY_LIMIT = 100;

function isContainer(value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } {
  return Array.isArray(value) || (value !== null && typeof value === "object");
}

function entriesOf(value: JsonValue[] | { [key: string]: JsonValue }): Array<[string | number, JsonValue]> {
  return Array.isArray(value)
    ? value.map((entry, index) => [index, entry])
    : Object.entries(value);
}

function appendJsonPath(parent: string, key: string | number): string {
  if (typeof key === "number") {
    return `${parent}[${key}]`;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return `${parent}.${key}`;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}

function primitiveType(value: JsonPrimitive): "string" | "number" | "boolean" | "null" {
  return value === null ? "null" : typeof value as "string" | "number" | "boolean";
}

function jsonValueType(value: JsonValue): JsonDraftType {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return primitiveType(value);
}

function draftInput(value: JsonValue): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function displayPrimitive(value: JsonPrimitive): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return value === null ? "null" : String(value);
}

function copyValue(value: JsonValue): string {
  return isContainer(value) ? JSON.stringify(value, null, 2) : displayPrimitive(value);
}

function summarizeContainer(value: JsonValue[] | { [key: string]: JsonValue }): string {
  const count = entriesOf(value).length;
  return Array.isArray(value) ? `[${count}]` : `{${count}}`;
}

function collectStats(value: JsonValue): JsonStats {
  const stats: JsonStats = { arrays: 0, objects: 0, primitives: 0, total: 0 };
  const visit = (current: JsonValue) => {
    stats.total += 1;
    if (Array.isArray(current)) {
      stats.arrays += 1;
      current.forEach(visit);
      return;
    }
    if (current !== null && typeof current === "object") {
      stats.objects += 1;
      Object.values(current).forEach(visit);
      return;
    }
    stats.primitives += 1;
  };
  visit(value);
  return stats;
}

function collectContainerPaths(value: JsonValue, minimumDepth = 0): Set<string> {
  const paths = new Set<string>();
  const visit = (current: JsonValue, path: string, depth: number) => {
    if (!isContainer(current)) return;
    if (depth >= minimumDepth) paths.add(path);
    for (const [key, child] of entriesOf(current)) {
      visit(child, appendJsonPath(path, key), depth + 1);
    }
  };
  visit(value, "$", 0);
  return paths;
}

function collectSearchState(value: JsonValue, query: string): {
  matchedPaths: Set<string>;
  visiblePaths: Set<string>;
} {
  const normalized = query.trim().toLocaleLowerCase();
  const matchedPaths = new Set<string>();
  const visiblePaths = new Set<string>();
  if (!normalized) return { matchedPaths, visiblePaths };

  const visit = (
    current: JsonValue,
    path: string,
    key: string | number | undefined,
    ancestors: string[]
  ) => {
    const keyText = key === undefined ? "root" : String(key);
    const valueText = isContainer(current)
      ? summarizeContainer(current)
      : displayPrimitive(current);
    if (
      keyText.toLocaleLowerCase().includes(normalized) ||
      path.toLocaleLowerCase().includes(normalized) ||
      valueText.toLocaleLowerCase().includes(normalized)
    ) {
      matchedPaths.add(path);
      visiblePaths.add(path);
      ancestors.forEach((ancestor) => visiblePaths.add(ancestor));
    }

    if (isContainer(current)) {
      for (const [childKey, child] of entriesOf(current)) {
        visit(child, appendJsonPath(path, childKey), childKey, [...ancestors, path]);
      }
    }
  };

  visit(value, "$", undefined, []);
  return { matchedPaths, visiblePaths };
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Use the local textarea fallback below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

const JsonMutationDialog: React.FC<{
  action: JsonEditorAction;
  onCancel: () => void;
  onConfirm: (draft: JsonMutationDraft) => string | null;
}> = ({ action, onCancel, onConfirm }) => {
  const { t } = useI18n();
  const initialValue = action.kind === "edit" ? action.value : "";
  const [key, setKey] = useState(
    action.kind === "rename" ? action.currentKey : ""
  );
  const [valueType, setValueType] = useState<JsonDraftType>(
    action.kind === "edit" ? jsonValueType(action.value) : "string"
  );
  const [valueInput, setValueInput] = useState(draftInput(initialValue));
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null
  >(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const parentIsArray = action.kind === "add" && Array.isArray(action.parent);
  const needsKey = action.kind === "rename" || (action.kind === "add" && !parentIsArray);
  const needsValue = action.kind === "add" || action.kind === "edit";

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    firstInputRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);

  const title =
    action.kind === "add"
      ? t("jsonPreview.addNode")
      : action.kind === "edit"
        ? t("jsonPreview.editNode")
        : action.kind === "rename"
          ? t("jsonPreview.renameKey")
          : t("jsonPreview.deleteNode");

  const submit = () => {
    setError(null);
    if (needsKey && !key.trim()) {
      setError(t("jsonPreview.keyRequired"));
      return;
    }

    if (action.kind === "delete") {
      const mutationError = onConfirm({});
      if (mutationError) setError(mutationError);
      return;
    }

    if (action.kind === "rename") {
      const mutationError = onConfirm({ key });
      if (mutationError) setError(mutationError);
      return;
    }

    let value: JsonValue;
    switch (valueType) {
      case "number": {
        const normalized = valueInput.trim();
        const parsedNumber = Number(normalized);
        if (!normalized || !Number.isFinite(parsedNumber)) {
          setError(t("jsonPreview.invalidNumber"));
          return;
        }
        value = parsedNumber;
        break;
      }
      case "boolean":
        value = valueInput !== "false";
        break;
      case "null":
        value = null;
        break;
      case "object":
        value = {};
        break;
      case "array":
        value = [];
        break;
      default:
        value = valueInput;
    }

    const mutationError = onConfirm({ key: needsKey ? key : undefined, value });
    if (mutationError) setError(mutationError);
  };

  return (
    <div
      className="json-preview-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <section
        className={`json-preview-dialog${action.kind === "delete" ? " danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="json-preview-dialog-title"
        aria-describedby="json-preview-dialog-description"
      >
        <header>
          <div>
            <span>{t("jsonPreview.parser")}</span>
            <h2 id="json-preview-dialog-title">{title}</h2>
          </div>
          <button
            ref={(node) => {
              if (action.kind === "delete" && !firstInputRef.current) {
                firstInputRef.current = node;
              }
            }}
            type="button"
            onClick={onCancel}
            aria-label={t("common.close")}
          >
            <X size={15} />
          </button>
        </header>

        <p id="json-preview-dialog-description" className="json-preview-dialog-path">
          {action.displayPath}
        </p>

        {action.kind === "delete" ? (
          <p className="json-preview-delete-warning">
            {t("jsonPreview.deleteWarning")}
          </p>
        ) : (
          <div className="json-preview-dialog-fields">
            {needsKey && (
              <label>
                <span>{t("jsonPreview.keyName")}</span>
                <input
                  ref={(node) => {
                    if (!firstInputRef.current) firstInputRef.current = node;
                  }}
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !needsValue) submit();
                  }}
                  spellCheck={false}
                />
              </label>
            )}
            {needsValue && (
              <>
                <label>
                  <span>{t("jsonPreview.valueType")}</span>
                  <select
                    ref={(node) => {
                      if (!firstInputRef.current) firstInputRef.current = node;
                    }}
                    value={valueType}
                    onChange={(event) => {
                      const nextType = event.target.value as JsonDraftType;
                      setValueType(nextType);
                      if (nextType === "boolean" && valueInput !== "true" && valueInput !== "false") {
                        setValueInput("true");
                      }
                      setError(null);
                    }}
                  >
                    <option value="string">{t("jsonPreview.typeString")}</option>
                    <option value="number">{t("jsonPreview.typeNumber")}</option>
                    <option value="boolean">{t("jsonPreview.typeBoolean")}</option>
                    <option value="null">{t("jsonPreview.typeNull")}</option>
                    <option value="object">{t("jsonPreview.typeObject")}</option>
                    <option value="array">{t("jsonPreview.typeArray")}</option>
                  </select>
                </label>
                {(valueType === "string" || valueType === "number") && (
                  <label>
                    <span>{t("jsonPreview.nodeValue")}</span>
                    <input
                      value={valueInput}
                      onChange={(event) => {
                        setValueInput(event.target.value);
                        setError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submit();
                      }}
                      spellCheck={valueType === "string"}
                    />
                  </label>
                )}
                {valueType === "boolean" && (
                  <label>
                    <span>{t("jsonPreview.nodeValue")}</span>
                    <select
                      value={valueInput === "false" ? "false" : "true"}
                      onChange={(event) => {
                        setValueInput(event.target.value);
                        setError(null);
                      }}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  </label>
                )}
                {(valueType === "object" || valueType === "array") && (
                  <p className="json-preview-value-hint">
                    {t("jsonPreview.emptyContainerHint")}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {error && <div className="json-preview-dialog-error" role="alert">{error}</div>}

        <footer>
          <button type="button" onClick={onCancel}>{t("common.cancel")}</button>
          <button
            type="button"
            className={action.kind === "delete" ? "danger" : "primary"}
            onClick={submit}
          >
            {action.kind === "delete" ? t("jsonPreview.deleteNode") : t("jsonPreview.applyChange")}
          </button>
        </footer>
      </section>
    </div>
  );
};

const JsonNode: React.FC<JsonNodeProps> = ({
  value,
  nodeKey,
  path,
  nodePath,
  depth,
  collapsed,
  matchedPaths,
  visiblePaths,
  queryActive,
  ancestorMatched = false,
  copiedTarget,
  canModify,
  onToggle,
  onCopy,
  onAdd,
  onEdit,
  onRename,
  onDelete,
}) => {
  const { t } = useI18n();
  const container = isContainer(value);
  const matched = matchedPaths.has(path);
  const showDescendants = ancestorMatched || matched;
  const isCollapsed = collapsed.has(path) && !queryActive;
  const entries = container ? entriesOf(value) : [];
  const label = nodeKey === undefined ? t("jsonPreview.root") : String(nodeKey);
  const valueTarget = `value:${path}`;
  const pathTarget = `path:${path}`;

  return (
    <div
      className={`json-preview-node${matched ? " matched" : ""}`}
      role="treeitem"
      aria-expanded={container ? !isCollapsed : undefined}
      data-json-path={path}
    >
      <div className="json-preview-row" style={{ paddingLeft: `${depth * 18 + 8}px` }}>
        {container ? (
          <button
            type="button"
            className="json-preview-toggle"
            onClick={() => onToggle(path)}
            aria-label={isCollapsed ? t("jsonPreview.expandNode") : t("jsonPreview.collapseNode")}
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : (
          <span className="json-preview-toggle-spacer" />
        )}

        <span className={`json-preview-key${nodeKey === undefined ? " root" : ""}`} title={label}>
          {label}
        </span>
        <span className="json-preview-separator">:</span>

        {container ? (
          <span className="json-preview-container-summary">
            {summarizeContainer(value)}
            <small>{Array.isArray(value) ? t("jsonPreview.array") : t("jsonPreview.object")}</small>
          </span>
        ) : (
          <span
            className={`json-preview-value type-${primitiveType(value)}`}
            title={displayPrimitive(value)}
          >
            {displayPrimitive(value)}
          </span>
        )}

        <span className="json-preview-row-actions">
          {canModify && container && (
            <button
              type="button"
              onClick={() => onAdd(nodePath, path, value)}
              title={t("jsonPreview.addNode")}
              aria-label={t("jsonPreview.addNode")}
            >
              <Plus size={12} />
            </button>
          )}
          {canModify && !container && (
            <button
              type="button"
              onClick={() => onEdit(nodePath, path, value)}
              title={t("jsonPreview.editNode")}
              aria-label={t("jsonPreview.editNode")}
            >
              <Pencil size={12} />
            </button>
          )}
          {canModify && typeof nodeKey === "string" && (
            <button
              type="button"
              onClick={() => onRename(nodePath, path, nodeKey)}
              title={t("jsonPreview.renameKey")}
              aria-label={t("jsonPreview.renameKey")}
            >
              <KeyRound size={12} />
            </button>
          )}
          {canModify && nodeKey !== undefined && (
            <button
              type="button"
              className="danger"
              onClick={() => onDelete(nodePath, path)}
              title={t("jsonPreview.deleteNode")}
              aria-label={t("jsonPreview.deleteNode")}
            >
              <Trash2 size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => onCopy(pathTarget, path)}
            title={t("jsonPreview.copyPath")}
            aria-label={t("jsonPreview.copyPath")}
          >
            {copiedTarget === pathTarget ? <Check size={12} /> : <Braces size={12} />}
          </button>
          <button
            type="button"
            onClick={() => onCopy(valueTarget, copyValue(value))}
            title={t("jsonPreview.copyValue")}
            aria-label={t("jsonPreview.copyValue")}
          >
            {copiedTarget === valueTarget ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </span>
      </div>

      {container && !isCollapsed && entries.length > 0 && (
        <div role="group">
          {entries.map(([childKey, child]) => {
            const childPath = appendJsonPath(path, childKey);
            if (queryActive && !showDescendants && !visiblePaths.has(childPath)) {
              return null;
            }
            return (
              <JsonNode
                key={childPath}
                value={child}
                nodeKey={childKey}
                path={childPath}
                nodePath={[...nodePath, childKey]}
                depth={depth + 1}
                collapsed={collapsed}
                matchedPaths={matchedPaths}
                visiblePaths={visiblePaths}
                queryActive={queryActive}
                ancestorMatched={showDescendants}
                copiedTarget={copiedTarget}
                canModify={canModify}
                onToggle={onToggle}
                onCopy={onCopy}
                onAdd={onAdd}
                onEdit={onEdit}
                onRename={onRename}
                onDelete={onDelete}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

const JsonPreview: React.FC<{
  content: string;
  path: string;
  readOnly: boolean;
  onChange?: (content: string) => void;
}> = ({ content, path, readOnly, onChange }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const [editorAction, setEditorAction] = useState<JsonEditorAction | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const historyDocumentRef = useRef(path);
  const lastAppliedContentRef = useRef(content);
  const canModify = !readOnly && Boolean(onChange);

  const parsed = useMemo(() => {
    try {
      return { value: JSON.parse(content) as JsonValue, error: null };
    } catch (error) {
      return {
        value: undefined,
        error: error instanceof Error ? error.message : t("jsonPreview.invalidJson"),
      };
    }
  }, [content, t]);

  const allContainerPaths = useMemo(
    () => parsed.error || parsed.value === undefined ? new Set<string>() : collectContainerPaths(parsed.value),
    [parsed]
  );
  const initialCollapsedPaths = useMemo(
    () => parsed.error || parsed.value === undefined ? new Set<string>() : collectContainerPaths(parsed.value, 2),
    [parsed]
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(initialCollapsedPaths);

  useEffect(() => {
    setCollapsed(new Set(initialCollapsedPaths));
    setQuery("");
  }, [initialCollapsedPaths, path]);

  useEffect(() => {
    if (historyDocumentRef.current !== path) {
      historyDocumentRef.current = path;
      lastAppliedContentRef.current = content;
      setUndoStack([]);
      setRedoStack([]);
      setEditorAction(null);
      return;
    }

    if (lastAppliedContentRef.current !== content) {
      lastAppliedContentRef.current = content;
      setUndoStack([]);
      setRedoStack([]);
      setEditorAction(null);
    }
  }, [content, path]);

  const stats = useMemo(
    () => parsed.error || parsed.value === undefined ? null : collectStats(parsed.value),
    [parsed]
  );
  const searchState = useMemo(
    () => parsed.error || parsed.value === undefined
      ? { matchedPaths: new Set<string>(), visiblePaths: new Set<string>() }
      : collectSearchState(parsed.value, query),
    [parsed, query]
  );
  const queryActive = Boolean(query.trim());

  const handleToggle = (nodePath: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(nodePath)) next.delete(nodePath);
      else next.add(nodePath);
      return next;
    });
  };

  const handleCopy = async (target: string, value: string) => {
    if (!(await writeClipboard(value))) return;
    setCopiedTarget(target);
    window.setTimeout(() => setCopiedTarget((current) => current === target ? null : current), 1200);
  };

  const applyContent = (nextContent: string, recordHistory = true) => {
    if (!onChange || nextContent === content) return false;
    if (recordHistory) {
      setUndoStack((current) => [...current.slice(-(HISTORY_LIMIT - 1)), content]);
      setRedoStack([]);
    }
    lastAppliedContentRef.current = nextContent;
    onChange(nextContent);
    return true;
  };

  const applyValue = (value: JsonValue) => applyContent(formatJson(value));

  const handleUndo = () => {
    if (!onChange || undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current.slice(-(HISTORY_LIMIT - 1)), content]);
    lastAppliedContentRef.current = previous;
    onChange(previous);
  };

  const handleRedo = () => {
    if (!onChange || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current.slice(-(HISTORY_LIMIT - 1)), content]);
    lastAppliedContentRef.current = next;
    onChange(next);
  };

  const mutationError = (error: unknown, key?: string): string => {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("already exists")) {
      return t("jsonPreview.duplicateKey", { key: key || "" });
    }
    return t("jsonPreview.mutationFailed");
  };

  const handleMutationConfirm = (draft: JsonMutationDraft): string | null => {
    if (!editorAction || parsed.value === undefined || !canModify) {
      return t("jsonPreview.readOnly");
    }

    try {
      let nextValue: JsonValue;
      switch (editorAction.kind) {
        case "add":
          nextValue = addJsonChild(
            parsed.value,
            editorAction.path,
            draft.key,
            draft.value ?? null
          );
          setCollapsed((current) => {
            const next = new Set(current);
            next.delete(editorAction.displayPath);
            return next;
          });
          break;
        case "edit":
          nextValue = replaceJsonNode(
            parsed.value,
            editorAction.path,
            draft.value ?? null
          );
          break;
        case "rename":
          nextValue = renameJsonKey(parsed.value, editorAction.path, draft.key || "");
          break;
        case "delete":
          nextValue = deleteJsonNode(parsed.value, editorAction.path);
          break;
      }

      applyValue(nextValue);
      setEditorAction(null);
      return null;
    } catch (error) {
      return mutationError(error, draft.key);
    }
  };

  if (parsed.error) {
    return (
      <div className="file-preview-surface json-preview json-preview-invalid">
        <div className="json-preview-error-icon"><AlertCircle size={22} /></div>
        <div>
          <span>{t("jsonPreview.invalidJson")}</span>
          <h2>{t("jsonPreview.unableToVisualize")}</h2>
          <p>{parsed.error}</p>
          <code>{path}</code>
        </div>
      </div>
    );
  }

  if (parsed.value === undefined || !stats) return null;

  return (
    <div className="file-preview-surface json-preview">
      <header className="json-preview-header">
        <div className="json-preview-title">
          <span className="json-preview-file-icon"><FileJson size={17} /></span>
          <div>
            <span className="json-preview-product-label">{t("jsonPreview.parser")}</span>
            <strong>{path.split("/").pop() || path}</strong>
            <code>{path}</code>
          </div>
        </div>
        <div className="json-preview-stats" aria-label={t("jsonPreview.statistics")}>
          <span><strong>{stats.total}</strong>{t("jsonPreview.nodes")}</span>
          <span><strong>{stats.objects}</strong>{t("jsonPreview.objects")}</span>
          <span><strong>{stats.arrays}</strong>{t("jsonPreview.arrays")}</span>
          <span><strong>{stats.primitives}</strong>{t("jsonPreview.values")}</span>
        </div>
      </header>

      <div className="json-preview-toolbar">
        <label className="json-preview-search">
          <Search size={14} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("jsonPreview.searchPlaceholder")}
            aria-label={t("jsonPreview.searchPlaceholder")}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label={t("common.clear")}>
              <X size={13} />
            </button>
          )}
        </label>
        <span className={`json-preview-match-count${queryActive && searchState.matchedPaths.size === 0 ? " empty" : ""}`} aria-live="polite">
          {queryActive
            ? t("jsonPreview.matches", { count: searchState.matchedPaths.size })
            : t("jsonPreview.ready")}
        </span>
        {!canModify && (
          <span className="json-preview-readonly" title={t("jsonPreview.readOnlyHint")}>
            <LockKeyhole size={12} />{t("jsonPreview.readOnly")}
          </span>
        )}
        <div className="json-preview-toolbar-actions">
          {canModify && (
            <>
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                title={t("jsonPreview.undo")}
                aria-label={t("jsonPreview.undo")}
              >
                <Undo2 size={14} /><span>{t("jsonPreview.undo")}</span>
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                title={t("jsonPreview.redo")}
                aria-label={t("jsonPreview.redo")}
              >
                <Redo2 size={14} /><span>{t("jsonPreview.redo")}</span>
              </button>
            </>
          )}
          <button type="button" onClick={() => setCollapsed(new Set())}>
            <UnfoldVertical size={14} />{t("jsonPreview.expandAll")}
          </button>
          <button type="button" onClick={() => setCollapsed(new Set(allContainerPaths))}>
            <FoldVertical size={14} />{t("jsonPreview.collapseAll")}
          </button>
          <button type="button" onClick={() => handleCopy("document", JSON.stringify(parsed.value, null, 2))}>
            {copiedTarget === "document" ? <Check size={14} /> : <Copy size={14} />}
            {copiedTarget === "document" ? t("jsonPreview.copied") : t("jsonPreview.copyDocument")}
          </button>
        </div>
      </div>

      <div className="json-preview-tree" role="tree" aria-label={t("jsonPreview.treeLabel")}>
        {queryActive && searchState.matchedPaths.size === 0 ? (
          <div className="json-preview-empty">
            <Search size={20} />
            <strong>{t("jsonPreview.noMatches")}</strong>
            <span>{t("jsonPreview.noMatchesHint")}</span>
          </div>
        ) : (
          <JsonNode
            value={parsed.value}
            path="$"
            nodePath={[]}
            depth={0}
            collapsed={collapsed}
            matchedPaths={searchState.matchedPaths}
            visiblePaths={searchState.visiblePaths}
            queryActive={queryActive}
            copiedTarget={copiedTarget}
            canModify={canModify}
            onToggle={handleToggle}
            onCopy={handleCopy}
            onAdd={(nodePath, displayPath, value) =>
              setEditorAction({ kind: "add", path: nodePath, displayPath, parent: value })
            }
            onEdit={(nodePath, displayPath, value) =>
              setEditorAction({ kind: "edit", path: nodePath, displayPath, value })
            }
            onRename={(nodePath, displayPath, currentKey) =>
              setEditorAction({ kind: "rename", path: nodePath, displayPath, currentKey })
            }
            onDelete={(nodePath, displayPath) =>
              setEditorAction({ kind: "delete", path: nodePath, displayPath })
            }
          />
        )}
      </div>
      {editorAction && (
        <JsonMutationDialog
          action={editorAction}
          onCancel={() => setEditorAction(null)}
          onConfirm={handleMutationConfirm}
        />
      )}
    </div>
  );
};

export const jsonPreviewPlugin: BuiltinPluginDefinition = {
  manifest: {
    id: "builtin.json-preview",
    name: "JSON Parser",
    version: "2.0.0",
    kind: "builtin",
    defaultEnabled: true,
    enabled: true,
    permissions: [...permissions],
    scopes: derivePluginScopes([...permissions]),
    loadable: true,
    description: "Parses JSON into an editable hierarchy with reversible node operations, search, and copy actions.",
    author: "CrownForge",
  },
  activate(context) {
    context.ui.registerLocaleBundle({
      locale: "en",
      label: "English",
      messages: {
        "jsonPreview.root": "root",
        "jsonPreview.parser": "JSON Parser",
        "jsonPreview.array": "array",
        "jsonPreview.object": "object",
        "jsonPreview.nodes": "nodes",
        "jsonPreview.objects": "objects",
        "jsonPreview.arrays": "arrays",
        "jsonPreview.values": "values",
        "jsonPreview.statistics": "JSON statistics",
        "jsonPreview.searchPlaceholder": "Search keys, paths, or values...",
        "jsonPreview.matches": "{count} matches",
        "jsonPreview.ready": "Tree ready",
        "jsonPreview.expandAll": "Expand all",
        "jsonPreview.collapseAll": "Collapse all",
        "jsonPreview.copyDocument": "Copy JSON",
        "jsonPreview.copied": "Copied",
        "jsonPreview.copyPath": "Copy JSON path",
        "jsonPreview.copyValue": "Copy value",
        "jsonPreview.expandNode": "Expand node",
        "jsonPreview.collapseNode": "Collapse node",
        "jsonPreview.noMatches": "No matching JSON nodes",
        "jsonPreview.noMatchesHint": "Try a key, JSON path, or primitive value.",
        "jsonPreview.invalidJson": "Invalid JSON",
        "jsonPreview.unableToVisualize": "This file cannot be visualized yet",
        "jsonPreview.treeLabel": "JSON tree",
        "jsonPreview.addNode": "Add child node",
        "jsonPreview.editNode": "Edit node",
        "jsonPreview.renameKey": "Rename key",
        "jsonPreview.deleteNode": "Delete node",
        "jsonPreview.deleteWarning": "This removes the selected node and all of its children. You can undo the change before leaving this document.",
        "jsonPreview.keyName": "Key",
        "jsonPreview.valueType": "Value type",
        "jsonPreview.nodeValue": "Value",
        "jsonPreview.typeString": "String",
        "jsonPreview.typeNumber": "Number",
        "jsonPreview.typeBoolean": "Boolean",
        "jsonPreview.typeNull": "Null",
        "jsonPreview.typeObject": "Object",
        "jsonPreview.typeArray": "Array",
        "jsonPreview.emptyContainerHint": "An empty container will be created. Add its children from the tree.",
        "jsonPreview.keyRequired": "Enter a non-empty key.",
        "jsonPreview.invalidNumber": "Enter a finite JSON number.",
        "jsonPreview.duplicateKey": "The key “{key}” already exists in this object.",
        "jsonPreview.mutationFailed": "The JSON hierarchy changed before this action could be applied. Try again.",
        "jsonPreview.applyChange": "Apply change",
        "jsonPreview.undo": "Undo",
        "jsonPreview.redo": "Redo",
        "jsonPreview.readOnly": "Read only",
        "jsonPreview.readOnlyHint": "This workspace does not allow JSON hierarchy changes.",
      },
    });
    context.ui.registerLocaleBundle({
      locale: "zh-CN",
      label: "简体中文",
      messages: {
        "jsonPreview.root": "根节点",
        "jsonPreview.parser": "JSON 解析器",
        "jsonPreview.array": "数组",
        "jsonPreview.object": "对象",
        "jsonPreview.nodes": "节点",
        "jsonPreview.objects": "对象",
        "jsonPreview.arrays": "数组",
        "jsonPreview.values": "值",
        "jsonPreview.statistics": "JSON 统计",
        "jsonPreview.searchPlaceholder": "搜索键、路径或值…",
        "jsonPreview.matches": "{count} 个匹配",
        "jsonPreview.ready": "树视图已就绪",
        "jsonPreview.expandAll": "全部展开",
        "jsonPreview.collapseAll": "全部折叠",
        "jsonPreview.copyDocument": "复制 JSON",
        "jsonPreview.copied": "已复制",
        "jsonPreview.copyPath": "复制 JSON 路径",
        "jsonPreview.copyValue": "复制值",
        "jsonPreview.expandNode": "展开节点",
        "jsonPreview.collapseNode": "折叠节点",
        "jsonPreview.noMatches": "没有匹配的 JSON 节点",
        "jsonPreview.noMatchesHint": "尝试搜索键、JSON 路径或基础值。",
        "jsonPreview.invalidJson": "JSON 格式无效",
        "jsonPreview.unableToVisualize": "暂时无法可视化此文件",
        "jsonPreview.treeLabel": "JSON 树",
        "jsonPreview.addNode": "添加子节点",
        "jsonPreview.editNode": "编辑节点",
        "jsonPreview.renameKey": "重命名键",
        "jsonPreview.deleteNode": "删除节点",
        "jsonPreview.deleteWarning": "这会删除所选节点及其全部子节点。离开当前文档前可以撤销此修改。",
        "jsonPreview.keyName": "键名",
        "jsonPreview.valueType": "值类型",
        "jsonPreview.nodeValue": "值",
        "jsonPreview.typeString": "字符串",
        "jsonPreview.typeNumber": "数字",
        "jsonPreview.typeBoolean": "布尔值",
        "jsonPreview.typeNull": "空值",
        "jsonPreview.typeObject": "对象",
        "jsonPreview.typeArray": "数组",
        "jsonPreview.emptyContainerHint": "将创建一个空容器，可继续在树中添加子节点。",
        "jsonPreview.keyRequired": "请输入非空键名。",
        "jsonPreview.invalidNumber": "请输入有效且有限的 JSON 数字。",
        "jsonPreview.duplicateKey": "当前对象中已存在键“{key}”。",
        "jsonPreview.mutationFailed": "JSON 层级已发生变化，当前操作无法应用，请重试。",
        "jsonPreview.applyChange": "应用修改",
        "jsonPreview.undo": "撤销",
        "jsonPreview.redo": "重做",
        "jsonPreview.readOnly": "只读",
        "jsonPreview.readOnlyHint": "当前工作区不允许修改 JSON 层级。",
      },
    });
    context.editor.registerPreviewRenderer({
      id: "builtin.json-preview.renderer",
      priority: 200,
      defaultMode: "preview",
      matches({ path, language }) {
        return /(?:^|\/)[^/]+\.json$/i.test(path) || (language === "json" && !path.toLowerCase().endsWith(".jsonc"));
      },
      render({ content, path, readOnly, onChange }) {
        return (
          <JsonPreview
            content={content}
            path={path}
            readOnly={readOnly}
            onChange={onChange}
          />
        );
      },
    });
  },
};
