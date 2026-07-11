import React, { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { WorkspaceSearchResult } from "../hooks/useFileSystem";
import { useI18n } from "../i18n";

interface WorkspaceSearchPanelProps {
  visible: boolean;
  onClose: () => void;
  onSearch: (query: string) => Promise<WorkspaceSearchResult[]>;
  onOpenResult: (result: WorkspaceSearchResult) => void;
}

export const WorkspaceSearchPanel: React.FC<WorkspaceSearchPanelProps> = ({
  visible,
  onClose,
  onSearch,
  onOpenResult,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setResults([]);
    setError(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [visible]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        setResults(await onSearch(trimmed));
      } catch {
        setError(t("search.failed"));
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [onSearch, query, t]);

  if (!visible) return null;

  return (
    <div className="command-palette-overlay" onMouseDown={onClose}>
      <div className="workspace-search-panel command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-palette-input-row">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && onClose()}
            placeholder={t("search.placeholder")}
            aria-label={t("search.title")}
          />
          <button type="button" className="command-palette-close" onClick={onClose} title={t("common.cancel")}>
            <X size={15} />
          </button>
        </div>
        <div className="workspace-search-results">
          {loading && <div className="command-palette-empty">{t("search.searching")}</div>}
          {!loading && error && <div className="workspace-search-error">{error}</div>}
          {!loading && !error && query.trim() && results.length === 0 && (
            <div className="command-palette-empty">{t("search.noResults")}</div>
          )}
          {!loading && !query.trim() && <div className="command-palette-empty">{t("search.hint")}</div>}
          {results.map((result, index) => (
            <button type="button" key={`${result.path}:${result.line}:${index}`} className="workspace-search-result" onClick={() => { onOpenResult(result); onClose(); }}>
              <span className="workspace-search-result-path">{result.path}:{result.line}</span>
              <code>{result.preview || " "}</code>
            </button>
          ))}
        </div>
        <div className="command-palette-footer"><span>{t("search.resultLimit")}</span><span>Esc {t("command.close")}</span></div>
      </div>
    </div>
  );
};
