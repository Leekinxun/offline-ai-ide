import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson,
  FoldVertical,
  Search,
  UnfoldVertical,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { derivePluginScopes } from "../permissions";
import type { BuiltinPluginDefinition } from "../types";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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
  depth: number;
  collapsed: Set<string>;
  matchedPaths: Set<string>;
  visiblePaths: Set<string>;
  queryActive: boolean;
  ancestorMatched?: boolean;
  copiedTarget: string | null;
  onToggle: (path: string) => void;
  onCopy: (target: string, value: string) => void;
}

const permissions = ["editor.preview", "ui.messages"] as const;

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

const JsonNode: React.FC<JsonNodeProps> = ({
  value,
  nodeKey,
  path,
  depth,
  collapsed,
  matchedPaths,
  visiblePaths,
  queryActive,
  ancestorMatched = false,
  copiedTarget,
  onToggle,
  onCopy,
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
                depth={depth + 1}
                collapsed={collapsed}
                matchedPaths={matchedPaths}
                visiblePaths={visiblePaths}
                queryActive={queryActive}
                ancestorMatched={showDescendants}
                copiedTarget={copiedTarget}
                onToggle={onToggle}
                onCopy={onCopy}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

const JsonPreview: React.FC<{ content: string; path: string }> = ({ content, path }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);

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
        <div className="json-preview-toolbar-actions">
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
            depth={0}
            collapsed={collapsed}
            matchedPaths={searchState.matchedPaths}
            visiblePaths={searchState.visiblePaths}
            queryActive={queryActive}
            copiedTarget={copiedTarget}
            onToggle={handleToggle}
            onCopy={handleCopy}
          />
        )}
      </div>
    </div>
  );
};

export const jsonPreviewPlugin: BuiltinPluginDefinition = {
  manifest: {
    id: "builtin.json-preview",
    name: "JSON Visualizer",
    version: "1.0.0",
    kind: "builtin",
    defaultEnabled: true,
    enabled: true,
    permissions: [...permissions],
    scopes: derivePluginScopes([...permissions]),
    loadable: true,
    description: "Visualizes JSON files as searchable, collapsible trees with path and value copy actions.",
    author: "CrownForge",
  },
  activate(context) {
    context.ui.registerLocaleBundle({
      locale: "en",
      label: "English",
      messages: {
        "jsonPreview.root": "root",
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
      },
    });
    context.ui.registerLocaleBundle({
      locale: "zh-CN",
      label: "简体中文",
      messages: {
        "jsonPreview.root": "根节点",
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
      },
    });
    context.editor.registerPreviewRenderer({
      id: "builtin.json-preview.renderer",
      priority: 200,
      defaultMode: "preview",
      matches({ path, language }) {
        return /(?:^|\/)[^/]+\.json$/i.test(path) || (language === "json" && !path.toLowerCase().endsWith(".jsonc"));
      },
      render({ content, path }) {
        return <JsonPreview content={content} path={path} />;
      },
    });
  },
};
