import React from "react";
import { CollaborationState, ContextIndexState, ContextManifest, ContextState, KnowledgeState, McpState } from "../types";
import { useI18n } from "../i18n";
import { Database, Search, Users } from "lucide-react";

interface ContextStripProps {
  contextState: ContextState;
  mcpState: McpState;
  knowledgeState: KnowledgeState;
  contextManifest?: ContextManifest | null;
  contextIndexState?: ContextIndexState;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  onOpenSettings: () => void;
  collaboration?: CollaborationState | null;
  activeFilePath?: string | null;
  onOpenCollaboration?: () => void;
}

export const ContextStrip: React.FC<ContextStripProps> = ({
  contextState,
  mcpState,
  knowledgeState,
  contextManifest,
  contextIndexState,
  inspectorOpen = false,
  onToggleInspector,
  onOpenSettings,
  collaboration,
  activeFilePath,
  onOpenCollaboration,
}) => {
  const { t } = useI18n();
  const threshold = Math.max(contextState.threshold, 1);
  const progress = Math.min(100, Math.max(0, (contextState.estimatedTokens / threshold) * 100));
  const contextValue =
    contextState.status === "compacting"
      ? t("chat.contextCompacting")
      : contextState.status === "warning"
        ? t("chat.contextWarning")
        : contextState.estimatedTokens > 0
          ? t("chat.contextTokens", {
              used: Math.round(contextState.estimatedTokens / 1000),
              limit: Math.round(contextState.threshold / 1000),
            })
          : t("chat.contextReady");

  return (
    <div className="context-strip" aria-label={t("chat.contextStrip")}>
      <div className={`context-strip-card context-${contextState.status}`}>
        <div className="context-strip-card-head">
          <span className="context-strip-label">{t("chat.contextLabel")}</span>
          <span className="context-strip-value">{contextValue}</span>
        </div>
        <div className="context-strip-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
        {contextState.compactionCount > 0 && (
          <span className="context-strip-detail">
            {t("chat.contextCompressed", { count: contextState.compactionCount })}
          </span>
        )}
      </div>

      <button
        type="button"
        className={`context-strip-card context-strip-action manifest-${contextManifest?.status || "empty"}`}
        onClick={onToggleInspector}
        disabled={!onToggleInspector}
        aria-expanded={inspectorOpen}
        title={t("context.inspect")}
      >
        <span className="context-strip-label"><Search size={11} />{t("context.manifestLabel")}</span>
        <strong>{contextManifest
          ? t("context.sourceCount", { count: contextManifest.totals.includedSources })
          : t("context.noManifest")}</strong>
        <span className="context-strip-detail">
          {contextManifest
            ? t("context.tokenCount", { count: contextManifest.totals.estimatedTokens })
            : t(`context.index.${contextIndexState?.status || "idle"}`)}
        </span>
      </button>

      {collaboration && <button type="button" className="context-strip-card context-strip-action" onClick={onOpenCollaboration} disabled={!onOpenCollaboration} title={t("collaboration.title")}>
        <span className="context-strip-label"><Users size={11}/>{t("collaboration.title")}</span>
        <strong>{t("collaboration.contextSummary", { owners: collaboration.ownership?.claims.filter((item) => !activeFilePath || item.path === activeFilePath).length || 0, buffers: collaboration.buffers.filter((item) => item.dirty && (!activeFilePath || item.path === activeFilePath)).length })}</strong>
        <span className="context-strip-detail">{t("collaboration.contextDetail", { comments: collaboration.comments.filter((item) => !activeFilePath || item.anchor.path === activeFilePath).length, reviews: collaboration.reviewRequests.filter((item) => item.status === "open" && (!activeFilePath || item.anchor.path === activeFilePath)).length })}</span>
      </button>}

      <button
        type="button"
        className={`context-strip-card context-strip-action mcp-${mcpState.status}`}
        onClick={onOpenSettings}
        title={mcpState.message || t("chat.mcpHint")}
      >
        <span className="context-strip-label">MCP</span>
        <strong>{t("chat.mcpTools", { count: mcpState.toolCount })}</strong>
        <span className="context-strip-detail">
          {t("chat.mcpServers", { count: mcpState.serverCount })}
        </span>
      </button>

      <button
        type="button"
        className="context-strip-card context-strip-action"
        onClick={onOpenSettings}
        title={t("chat.knowledgeHint")}
      >
        <span className="context-strip-label"><Database size={11} />{t("chat.knowledgeLabel")}</span>
        <strong>{t("chat.knowledge", {
          memory: knowledgeState.memoryFiles,
          skills: knowledgeState.skillCount,
        })}</strong>
        <span className="context-strip-detail">{t("chat.knowledgeDetail")}</span>
      </button>
    </div>
  );
};
