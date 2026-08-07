import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import {
  WorkspaceSearchOptions,
  WorkspaceSearchResponse,
  WorkspaceSearchResult,
} from "../hooks/useFileSystem";
import type { FileNode } from "../types";
import { useI18n } from "../i18n";

interface WorkspaceSearchPanelProps {
  visible: boolean;
  tree: FileNode[];
  scopePath: string;
  onClose: () => void;
  onClearScope: () => void;
  onSearch: (options: WorkspaceSearchOptions) => Promise<WorkspaceSearchResponse>;
  onCancelSearch: () => void;
  onOpenResult: (result: WorkspaceSearchResult) => void;
}

interface DisplaySearchResult extends WorkspaceSearchResult {
  kind: "file" | "content";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectFileMatches(options: {
  tree: FileNode[];
  query: string;
  scopePath: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
}): DisplaySearchResult[] {
  const query = options.query.trim();
  if (!query) return [];

  let matcher: RegExp;
  try {
    const source = options.isRegex ? query : escapeRegExp(query);
    matcher = new RegExp(
      options.wholeWord ? `\\b(?:${source})\\b` : source,
      options.matchCase ? "u" : "iu"
    );
  } catch {
    return [];
  }

  const scopePrefix = options.scopePath ? `${options.scopePath.replace(/\/$/, "")}/` : "";
  const matches: DisplaySearchResult[] = [];
  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.type === "directory") {
        if (node.children) visit(node.children);
        continue;
      }
      if (
        options.scopePath &&
        node.path !== options.scopePath &&
        !node.path.startsWith(scopePrefix)
      ) {
        continue;
      }
      const match = matcher.exec(node.path);
      if (!match) continue;
      matches.push({
        kind: "file",
        path: node.path,
        line: 1,
        column: match.index + 1,
        matchLength: Math.max(1, match[0].length),
        preview: node.path,
      });
    }
  };
  visit(options.tree);
  return matches.sort((left, right) => left.path.localeCompare(right.path));
}

function renderPreview(result: WorkspaceSearchResult): React.ReactNode {
  const start = Math.max(0, result.column - 1);
  const end = start + result.matchLength;
  if (start >= result.preview.length) return result.preview || " ";
  return (
    <>
      {result.preview.slice(0, start)}
      <mark>{result.preview.slice(start, end)}</mark>
      {result.preview.slice(end)}
    </>
  );
}

export const WorkspaceSearchPanel: React.FC<WorkspaceSearchPanelProps> = ({
  visible,
  tree,
  scopePath,
  onClose,
  onClearScope,
  onSearch,
  onCancelSearch,
  onOpenResult,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [useIgnoreFiles, setUseIgnoreFiles] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) {
      onCancelSearch();
      return;
    }
    setQuery("");
    setResults([]);
    setError(null);
    setTruncated(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [onCancelSearch, visible]);

  useEffect(() => {
    if (!visible) return;
    const trimmed = query.trim();
    if (!trimmed) {
      onCancelSearch();
      setResults([]);
      setLoading(false);
      setError(null);
      setTruncated(false);
      return;
    }

    let active = true;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await onSearch({
          query: trimmed,
          scopePath: scopePath || undefined,
          isRegex,
          matchCase,
          wholeWord,
          include: include.trim() || undefined,
          exclude: exclude.trim() || undefined,
          useIgnoreFiles,
        });
        if (!active) return;
        setResults(response.results);
        setTruncated(response.truncated);
      } catch (searchError) {
        if (!active || (searchError instanceof DOMException && searchError.name === "AbortError")) {
          return;
        }
        setResults([]);
        setTruncated(false);
        setError(searchError instanceof Error ? searchError.message : t("search.failed"));
      } finally {
        if (active) setLoading(false);
      }
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
      onCancelSearch();
    };
  }, [
    exclude,
    include,
    isRegex,
    matchCase,
    onCancelSearch,
    onSearch,
    query,
    scopePath,
    t,
    useIgnoreFiles,
    visible,
    wholeWord,
  ]);

  const fileMatches = useMemo(() => collectFileMatches({
    tree,
    query,
    scopePath,
    isRegex,
    matchCase,
    wholeWord,
  }), [isRegex, matchCase, query, scopePath, tree, wholeWord]);
  const displayResults = useMemo<DisplaySearchResult[]>(() => [
    ...fileMatches,
    ...results.map((result) => ({ ...result, kind: "content" as const })),
  ], [fileMatches, results]);
  const groupedResults = useMemo(() => {
    const groups = new Map<string, DisplaySearchResult[]>();
    for (const result of displayResults) {
      const entries = groups.get(result.path) || [];
      entries.push(result);
      groups.set(result.path, entries);
    }
    return Array.from(groups.entries());
  }, [displayResults]);

  if (!visible) return null;

  return (
    <div className="command-palette-overlay" onMouseDown={onClose}>
      <div
        className="workspace-search-panel command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette-input-row workspace-search-input-row">
          <Search size={17} />
          <span id="workspace-search-title" className="sr-only">{t("search.title")}</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && onClose()}
            placeholder={t("search.placeholder")}
            aria-label={t("search.title")}
          />
          <div className="workspace-search-toggles">
            <button
              type="button"
              className={matchCase ? "active" : ""}
              onClick={() => setMatchCase((current) => !current)}
              title={t("search.matchCase")}
              aria-pressed={matchCase}
            >Aa</button>
            <button
              type="button"
              className={wholeWord ? "active" : ""}
              onClick={() => setWholeWord((current) => !current)}
              title={t("search.wholeWord")}
              aria-pressed={wholeWord}
            >ab</button>
            <button
              type="button"
              className={isRegex ? "active" : ""}
              onClick={() => setIsRegex((current) => !current)}
              title={t("search.regex")}
              aria-pressed={isRegex}
            >.*</button>
          </div>
          <button
            type="button"
            className="workspace-search-details-toggle"
            onClick={() => setShowDetails((current) => !current)}
            title={t("search.toggleDetails")}
            aria-expanded={showDetails}
          >…</button>
          <button type="button" className="command-palette-close" onClick={onClose} title={t("common.cancel")}>
            <X size={15} />
          </button>
        </div>

        {scopePath && (
          <div className="workspace-search-scope">
            <span>{t("search.scope")}</span>
            <code>{scopePath}</code>
            <button type="button" onClick={onClearScope} title={t("search.clearScope")}>
              <X size={13} />
            </button>
          </div>
        )}

        {showDetails && (
          <div className="workspace-search-details">
            <label>
              <span>{t("search.include")}</span>
              <input value={include} onChange={(event) => setInclude(event.target.value)} placeholder="src/**, *.{ts,tsx}" />
            </label>
            <label>
              <span>{t("search.exclude")}</span>
              <input value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="dist/**, coverage/**" />
            </label>
            <label className="workspace-search-ignore">
              <input
                type="checkbox"
                checked={useIgnoreFiles}
                onChange={(event) => setUseIgnoreFiles(event.target.checked)}
              />
              <span>{t("search.useIgnoreFiles")}</span>
            </label>
          </div>
        )}

        <div className="workspace-search-results">
          {loading && <div className="workspace-search-progress">{t("search.searching")}</div>}
          {!loading && error && <div className="workspace-search-error">{error}</div>}
          {!loading && !error && query.trim() && displayResults.length === 0 && (
            <div className="command-palette-empty">{t("search.noResults")}</div>
          )}
          {!loading && !query.trim() && <div className="command-palette-empty">{t("search.hint")}</div>}
          {!error && groupedResults.map(([resultPath, matches]) => (
            <section className="workspace-search-group" key={resultPath}>
              <div className="workspace-search-group-header">
                <span title={resultPath}>{resultPath}</span>
                <small>{matches.length}</small>
              </div>
              {matches.map((result, index) => (
                <button
                  type="button"
                  key={`${result.path}:${result.line}:${result.column}:${index}`}
                  className="workspace-search-result"
                  onClick={() => {
                    onOpenResult(result);
                    onClose();
                  }}
                >
                  <span className={`workspace-search-result-path kind-${result.kind}`}>
                    {result.kind === "file"
                      ? t("search.fileNameMatch")
                      : `${result.line}:${result.column}`}
                  </span>
                  <code>{renderPreview(result)}</code>
                </button>
              ))}
            </section>
          ))}
        </div>
        <div className="command-palette-footer">
          <span>{truncated ? t("search.resultsTruncated", { count: displayResults.length }) : t("search.resultCount", { count: displayResults.length })}</span>
          <span>Esc {t("command.close")}</span>
        </div>
      </div>
    </div>
  );
};
