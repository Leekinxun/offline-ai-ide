import React, { useState } from "react";
import { Check, ChevronRight, FileCode2, TerminalSquare, X } from "lucide-react";
import { AgentRunState, ConversationRunSummary } from "../types";
import { useI18n } from "../i18n";

interface RunDetailsPanelProps {
  visible: boolean;
  summary: ConversationRunSummary | null;
  runState: AgentRunState | null;
  errorCount: number;
  warningCount: number;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onClose: () => void;
}

type DetailTab = "changes" | "checks" | "terminal";

export const RunDetailsPanel: React.FC<RunDetailsPanelProps> = ({
  visible,
  summary,
  runState,
  errorCount,
  warningCount,
  onOpenFile,
  onOpenDiff,
  onClose,
}) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DetailTab>("changes");
  if (!visible) return null;

  const changedFiles = summary?.changedFiles || [];
  return (
    <aside className="run-details-panel" aria-label={t("workbench.runDetails")}> 
      <header className="run-details-header">
        <div>
          <strong>{t("workbench.runDetails")}</strong>
          <span>{runState ? t(`chat.taskStatus.${runState.status}`) : t("workbench.ready")}</span>
        </div>
        <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
          <X size={15} />
        </button>
      </header>
      <div className="run-details-tabs" role="tablist" aria-label={t("workbench.runDetails")}>
        {(["changes", "checks", "terminal"] as DetailTab[]).map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={activeTab === tab ? "active" : ""}
            onClick={() => setActiveTab(tab)}
            key={tab}
          >
            {t(`workbench.details.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === "changes" && (
        <div className="run-details-body">
          <section className="run-details-summary">
            <span>{t("workbench.filesChanged")}</span>
            <strong>{changedFiles.length}</strong>
          </section>
          <div className="run-details-section-title">
            <span>{t("workbench.changedFiles")}</span>
            <span>{changedFiles.length}</span>
          </div>
          {changedFiles.length === 0 ? (
            <div className="run-details-empty">{t("chat.noChanges")}</div>
          ) : (
            <div className="run-details-file-list">
              {changedFiles.map((path) => (
                <button type="button" key={path} onClick={() => onOpenDiff(path)}>
                  <FileCode2 size={14} />
                  <span><strong>{path.split("/").pop()}</strong><small>{path}</small></span>
                  <span className="run-details-file-state">M</span>
                  <ChevronRight size={13} />
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="run-details-open-file"
            disabled={changedFiles.length === 0}
            onClick={() => changedFiles[0] && onOpenFile(changedFiles[0])}
          >
            {t("workbench.openFirstChange")}
          </button>
        </div>
      )}

      {activeTab === "checks" && (
        <div className="run-details-body run-check-list">
          <div><Check size={14} /><span>{t("workbench.toolCalls")}</span><strong>{summary?.toolCallCount || 0}</strong></div>
          <div><Check size={14} /><span>{t("workbench.commands")}</span><strong>{summary?.commandCount || 0}</strong></div>
          <div className={errorCount ? "warning" : ""}><Check size={14} /><span>{t("problems.error")}</span><strong>{errorCount}</strong></div>
          <div className={warningCount ? "warning" : ""}><Check size={14} /><span>{t("problems.warning")}</span><strong>{warningCount}</strong></div>
        </div>
      )}

      {activeTab === "terminal" && (
        <div className="run-details-terminal">
          <TerminalSquare size={15} />
          <div>
            <strong>{runState?.event?.label || t("workbench.terminalIdle")}</strong>
            <pre>{runState?.event?.detail || t("workbench.terminalHint")}</pre>
          </div>
        </div>
      )}
    </aside>
  );
};
