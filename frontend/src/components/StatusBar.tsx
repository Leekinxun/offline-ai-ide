import React from "react";
import { useI18n } from "../i18n";
import type { AiHealthInfo } from "../hooks/useChat";

interface StatusBarProps {
  activeFile: { path: string; language: string } | null;
  cursorPosition: { line: number; column: number };
  connected: boolean;
  aiHealth?: AiHealthInfo;
  teamName?: string | null;
  teamOnlineCount?: number;
  teamRole?: string | null;
  onOpenTeam?: () => void;
  readOnlyWorkspace?: boolean;
  errorCount?: number;
  warningCount?: number;
  onOpenProblems?: () => void;
  activeRunLabel?: string | null;
  onOpenRunCenter?: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  activeFile,
  cursorPosition,
  connected,
  aiHealth,
  teamName,
  teamOnlineCount,
  teamRole,
  onOpenTeam,
  readOnlyWorkspace,
  errorCount = 0,
  warningCount = 0,
  onOpenProblems,
  activeRunLabel,
  onOpenRunCenter,
}) => {
  const { t } = useI18n();
  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {activeFile && (
          <>
            <span>{activeFile.path}</span>
            <span>
              {t("statusBar.lineColumn", {
                line: cursorPosition.line,
                column: cursorPosition.column,
              })}
            </span>
          </>
        )}
      </div>
      <div className="statusbar-right">
        {(errorCount > 0 || warningCount > 0) && (
          <button type="button" className="statusbar-action" onClick={onOpenProblems} disabled={!onOpenProblems} title={t("statusBar.openProblems")}>
            <span className="statusbar-problem error">× {errorCount}</span>
            <span className="statusbar-problem warning">△ {warningCount}</span>
          </button>
        )}
        {activeRunLabel && (
          <button type="button" className="statusbar-action running" onClick={onOpenRunCenter} disabled={!onOpenRunCenter} title={t("statusBar.openRunCenter")}>
            <i /> {activeRunLabel}
          </button>
        )}
        {teamName && (
          <button type="button" className="statusbar-action" onClick={onOpenTeam} disabled={!onOpenTeam} title={t("team.openPanel")} aria-label={t("team.openPanel")}>
            {teamName}
            {typeof teamOnlineCount === "number" ? ` · ${teamOnlineCount}` : ""}
            {teamRole ? ` · ${teamRole}` : ""}
          </button>
        )}
        {readOnlyWorkspace && <span>{t("team.readOnlyBadge")}</span>}
        {activeFile && <span>{activeFile.language.toUpperCase()}</span>}
        <span>UTF-8</span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, cursor: "default" }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: !connected
                ? "var(--danger)"
                : aiHealth?.status === "ready"
                  ? "var(--success)"
                  : "var(--warning)",
              boxShadow: !connected
                ? undefined
                : aiHealth?.status === "ready"
                  ? "0 0 0 2px color-mix(in srgb, var(--success) 20%, transparent)"
                  : "0 0 0 2px color-mix(in srgb, var(--warning) 25%, transparent)",
            }}
          />
          {!connected
            ? t("status.serverDisconnected")
            : aiHealth?.status === "ready"
              ? t("status.aiOnline")
              : t("status.serverConnected")}
        </span>
      </div>
    </div>
  );
};
