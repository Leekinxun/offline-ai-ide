import React from "react";
import { BookOpen, PlugZap, Sparkles } from "lucide-react";
import { ContextState, KnowledgeState, McpState } from "../types";
import { useI18n } from "../i18n";

interface ContextStripProps {
  contextState: ContextState;
  mcpState: McpState;
  knowledgeState: KnowledgeState;
  onOpenSettings: () => void;
}

export const ContextStrip: React.FC<ContextStripProps> = ({
  contextState,
  mcpState,
  knowledgeState,
  onOpenSettings,
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
          <span className="context-strip-label">
            <Sparkles size={12} /> {t("chat.contextLabel")}
          </span>
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
        className={`context-strip-card context-strip-action mcp-${mcpState.status}`}
        onClick={onOpenSettings}
        title={mcpState.message || t("chat.mcpHint")}
      >
        <span className="context-strip-label">
          <PlugZap size={12} /> {t("chat.integrationsLabel")}
        </span>
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
        <span className="context-strip-label">
          <BookOpen size={12} /> {t("chat.knowledgeLabel")}
        </span>
        <strong>{t("chat.knowledge", {
          memory: knowledgeState.memoryFiles,
          skills: knowledgeState.skillCount,
        })}</strong>
        <span className="context-strip-detail">{t("chat.knowledgeDetail")}</span>
      </button>
    </div>
  );
};
