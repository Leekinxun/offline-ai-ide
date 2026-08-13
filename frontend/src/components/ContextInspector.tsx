import React, { useId, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Pin,
  PinOff,
  RefreshCw,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import {
  ContextIndexState,
  ContextManifest,
  ContextSource,
  ContextSourceDecision,
  ContextSourceMutation,
} from "../types";
import { useI18n } from "../i18n";

type ContextFilter = "all" | ContextSourceDecision | "pinned";

interface ContextInspectorProps {
  manifests: ContextManifest[];
  selectedManifestId?: string | null;
  indexState: ContextIndexState;
  mode: "draft" | "history";
  loading?: boolean;
  readOnly?: boolean;
  preferencesDisabledReason?: string;
  error?: string | null;
  emptyHint?: string;
  mutationBySource?: Record<string, ContextSourceMutation>;
  onSelectManifest?: (manifestId: string) => void;
  onPin?: (sourceKey: string) => void;
  onUnpin?: (sourceKey: string) => void;
  onExclude?: (sourceKey: string) => void;
  onRestore?: (sourceKey: string) => void;
  onRefreshSource?: (sourceKey: string) => void;
  onRefreshAll?: () => void;
  onRetry?: () => void;
}

function sourceTitle(source: ContextSource, fallback: string): string {
  return source.label || source.symbol || source.path?.split("/").pop() || fallback;
}

function manifestLabel(manifest: ContextManifest, fallback: string): string {
  return [manifest.purpose, manifest.modelName, manifest.modelCallId || manifest.requestId]
    .filter(Boolean)
    .join(" · ") || fallback;
}

export const ContextInspector: React.FC<ContextInspectorProps> = ({
  manifests,
  selectedManifestId,
  indexState,
  mode,
  loading = false,
  readOnly = false,
  preferencesDisabledReason,
  error,
  emptyHint,
  mutationBySource = {},
  onSelectManifest,
  onPin,
  onUnpin,
  onExclude,
  onRestore,
  onRefreshSource,
  onRefreshAll,
  onRetry,
}) => {
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<ContextFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const headingId = useId();
  const manifest = manifests.find((item) => item.id === selectedManifestId) || manifests[manifests.length - 1] || null;
  const sources = useMemo(() => {
    if (!manifest) return [];
    if (filter === "all") return manifest.sources;
    if (filter === "pinned") return manifest.sources.filter((source) => source.pinned);
    return manifest.sources.filter((source) => source.decision === filter);
  }, [filter, manifest]);

  const formatTime = (value?: number) => value
    ? new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      }).format(value)
    : t("context.timeUnknown");

  const toggleExpanded = (sourceId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  return (
    <section className="context-inspector" aria-labelledby={headingId} aria-busy={loading}>
      <header className="context-inspector-header">
        <div>
          <strong id={headingId}>{t("context.manifestTitle")}</strong>
          <span>{mode === "history" ? t("context.historyImmutable") : t("context.appliesNextCall")}</span>
        </div>
        <button
          type="button"
          onClick={onRefreshAll}
          disabled={!onRefreshAll || loading || readOnly}
          aria-label={t("context.refresh")}
          title={t("context.refresh")}
        >
          <RefreshCw size={14} className={loading ? "chat-spin" : ""} />
          <span>{t("context.refresh")}</span>
        </button>
      </header>
      {readOnly && <div className="context-read-only" role="status">{t("context.readOnly")}</div>}
      {!readOnly && preferencesDisabledReason && <div className="context-read-only" role="status">{preferencesDisabledReason}</div>}

      <div className={`context-index-state status-${indexState.status}`} role="status">
        <span aria-hidden="true" />
        <strong>{t(`context.index.${indexState.status}`)}</strong>
        {typeof indexState.indexedFiles === "number" && (
          <small>{t("context.indexedFiles", { count: indexState.indexedFiles })}</small>
        )}
        {indexState.updatedAt && <time>{formatTime(indexState.updatedAt)}</time>}
      </div>

      {manifests.length > 1 && (
        <label className="context-manifest-picker">
          <span>{t("context.modelCall")}</span>
          <select
            value={manifest?.id || ""}
            onChange={(event) => onSelectManifest?.(event.target.value)}
          >
            {manifests.map((item, index) => (
              <option key={item.id} value={item.id}>
                {manifestLabel(item, t("context.modelCallNumber", { count: index + 1 }))}
              </option>
            ))}
          </select>
        </label>
      )}

      {manifest && (
        <div className="context-manifest-summary">
          <span><strong>{manifest.totals.includedSources}</strong>{t("context.included")}</span>
          <span><strong>{manifest.totals.excludedSources}</strong>{t("context.excluded")}</span>
          <span><strong>{manifest.totals.estimatedTokens.toLocaleString()}</strong>{t("context.tokens")}</span>
        </div>
      )}

      <div className="context-filter-tabs" role="tablist" aria-label={t("context.filterLabel")}>
        {(["all", "included", "pinned", "excluded", "redacted", "truncated", "omitted"] as ContextFilter[]).map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={filter === item}
            className={filter === item ? "active" : ""}
            onClick={() => setFilter(item)}
            key={item}
          >
            {t(`context.filter.${item}`)}
          </button>
        ))}
      </div>

      {error && (
        <div className="context-inspector-error" role="alert">
          <span>{error}</span>
          {onRetry && <button type="button" onClick={onRetry}>{t("chat.retry")}</button>}
        </div>
      )}

      {!manifest && !loading ? (
        <div className="context-inspector-empty">
          <CircleOff size={18} />
          <strong>{t("context.noSources")}</strong>
          <span>{emptyHint || t("context.legacyEmptyHint")}</span>
        </div>
      ) : sources.length === 0 ? (
        <div className="context-inspector-empty">
          <CircleOff size={18} />
          <strong>{t("context.noFilteredSources")}</strong>
        </div>
      ) : (
        <ul className="context-source-list">
          {sources.map((source) => {
            const isExpanded = expanded.has(source.id);
            const mutation = mutationBySource[source.sourceKey];
            const pending = Boolean(mutation);
            return (
              <li className={`context-source-row decision-${source.decision}`} key={source.id}>
                <button
                  type="button"
                  className="context-source-main"
                  onClick={() => toggleExpanded(source.id)}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>
                    <strong>{sourceTitle(source, t("context.unknownSource"))}</strong>
                    <small>{source.reasonDetail || t(`context.reason.${source.reasonCode}`)}</small>
                  </span>
                  <span className="context-source-tokens">{t("context.tokenCount", { count: source.estimatedTokens })}</span>
                </button>

                <div className="context-source-badges">
                  <span className={`freshness-${source.freshness.state}`}>
                    <TimerReset size={11} />{t(`context.freshness.${source.freshness.state}`)}
                  </span>
                  <span className={`trust-${source.trust.level}`}>
                    <ShieldCheck size={11} />{t(`context.trust.${source.trust.basis}`)}
                  </span>
                  <span className={`decision-${source.decision}`}>
                    <CheckCircle2 size={11} />{t(`context.decision.${source.decision}`)}
                  </span>
                  {mutation && <span className="context-preference-pending" role="status">{t("context.preferencePending")}</span>}
                </div>

                {isExpanded && (
                  <div className="context-source-details">
                    <dl>
                      {source.path && <><dt>{t("context.path")}</dt><dd><code>{source.path}</code></dd></>}
                      {source.symbol && <><dt>{t("context.symbol")}</dt><dd><code>{source.symbol}</code></dd></>}
                      {source.range && <><dt>{t("context.lines")}</dt><dd>{source.range.startLine}–{source.range.endLine}</dd></>}
                      <dt>{t("context.reason")}</dt><dd>{source.reasonDetail || t(`context.reason.${source.reasonCode}`)}</dd>
                      <dt>{t("context.freshnessLabel")}</dt><dd>{t(`context.freshness.${source.freshness.state}`)} · {formatTime(source.freshness.observedAt)}</dd>
                      <dt>{t("context.trustLabel")}</dt><dd>{t(`context.trust.${source.trust.basis}`)}</dd>
                    </dl>
                    {source.preview && <pre>{source.preview}</pre>}
                  </div>
                )}

                {mode === "draft" && (
                  <div className="context-source-actions" aria-label={t("context.sourceActions")}>
                    <button
                      type="button"
                      aria-pressed={source.pinned}
                      disabled={readOnly || Boolean(preferencesDisabledReason) || pending || source.actions?.canPin === false}
                      onClick={() => source.pinned ? onUnpin?.(source.sourceKey) : onPin?.(source.sourceKey)}
                      title={source.pinned ? t("context.unpin") : t("context.pin")}
                    >
                      {source.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                      <span>{source.pinned ? t("context.unpin") : t("context.pin")}</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={source.decision === "excluded"}
                      disabled={readOnly || Boolean(preferencesDisabledReason) || pending || source.actions?.canExclude === false}
                      onClick={() => source.decision === "excluded" ? onRestore?.(source.sourceKey) : onExclude?.(source.sourceKey)}
                    >
                      <CircleOff size={13} />
                      <span>{source.decision === "excluded" ? t("context.restore") : t("context.exclude")}</span>
                    </button>
                    <button
                      type="button"
                      disabled={readOnly || pending || source.actions?.canRefresh === false}
                      onClick={() => onRefreshSource?.(source.sourceKey)}
                    >
                      <RefreshCw size={13} className={mutation === "refresh" ? "chat-spin" : ""} />
                      <span>{mutation ? t("context.updating") : t("context.refreshOne")}</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="context-inspector-announcer" aria-live="polite" aria-atomic="true">
        {loading ? t("context.loading") : ""}
      </div>
    </section>
  );
};
