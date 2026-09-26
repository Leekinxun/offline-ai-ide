import React from "react";
import { AlertTriangle, CircleX, FileCode2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { AiHealthInfo } from "../hooks/useChat";
import "./StatusBar.css";

export interface StatusBarProps {
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
  const connState = !connected
    ? "danger"
    : aiHealth?.status === "ready"
      ? "ready"
      : "warning";
  const connLabel = !connected
    ? t("status.serverDisconnected")
    : aiHealth?.status === "ready"
      ? t("status.aiOnline")
      : t("status.serverConnected");

  return (
    <div className="statusbar">
      {/* 左侧：常驻诊断徽标与文件焦点路径 */}
      <div className="statusbar-left">
        <button
          type="button"
          className="statusbar-item statusbar-problems"
          onClick={onOpenProblems}
          disabled={!onOpenProblems}
          title={t("statusBar.openProblems")}
        >
          <span className={`statusbar-problem error${errorCount === 0 ? " zero" : ""}`}>
            <CircleX size={13} strokeWidth={2} />
            <span>{errorCount}</span>
          </span>
          <span className={`statusbar-problem warning${warningCount === 0 ? " zero" : ""}`}>
            <AlertTriangle size={13} strokeWidth={2} />
            <span>{warningCount}</span>
          </span>
        </button>
        {activeFile && (
          <span className="statusbar-item statusbar-filepath">
            <FileCode2 size={13} strokeWidth={1.8} className="statusbar-icon-dim" />
            <span className="statusbar-filepath-text">{activeFile.path}</span>
          </span>
        )}
      </div>

      {/* 右侧：状态指标与全局连接灯（去除悬停提示） */}
      <div className="statusbar-right">
        {activeRunLabel && (
          <button
            type="button"
            className="statusbar-item statusbar-run"
            onClick={onOpenRunCenter}
            disabled={!onOpenRunCenter}
            title={t("statusBar.openRunCenter")}
          >
            <i /> <span>{activeRunLabel}</span>
          </button>
        )}
        {teamName && (
          <button
            type="button"
            className="statusbar-item statusbar-team"
            onClick={onOpenTeam}
            disabled={!onOpenTeam}
            title={t("team.openPanel")}
            aria-label={t("team.openPanel")}
          >
            <span>{teamName}</span>
            {typeof teamOnlineCount === "number" && <span>· {teamOnlineCount}</span>}
            {teamRole && <span>· {teamRole}</span>}
          </button>
        )}
        {readOnlyWorkspace && (
          <span className="statusbar-item statusbar-readonly-badge">
            {t("team.readOnlyBadge")}
          </span>
        )}
        {activeFile && (
          <span className="statusbar-item statusbar-cursor">
            {t("statusBar.lineColumn", {
              line: cursorPosition.line,
              column: cursorPosition.column,
            })}
          </span>
        )}
        {activeFile && (
          <span className="statusbar-item statusbar-lang">
            {activeFile.language.toUpperCase()}
          </span>
        )}
        <span className="statusbar-item statusbar-encoding">UTF-8</span>
        {/* 连接状态：纯指示展示，无悬停弹出文字 */}
        <span className="statusbar-item statusbar-connection">
          <span className={`statusbar-conn-dot ${connState}`} />
          <span className="statusbar-conn-label">{connLabel}</span>
        </span>
      </div>
    </div>
  );
};
