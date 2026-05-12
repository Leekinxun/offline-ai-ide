import React from "react";
import { useI18n } from "../i18n";

interface StatusBarProps {
  activeFile: { path: string; language: string } | null;
  cursorPosition: { line: number; column: number };
  connected: boolean;
  teamName?: string | null;
  teamOnlineCount?: number;
  teamRole?: string | null;
  readOnlyWorkspace?: boolean;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  activeFile,
  cursorPosition,
  connected,
  teamName,
  teamOnlineCount,
  teamRole,
  readOnlyWorkspace,
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
        {teamName && (
          <span>
            {teamName}
            {typeof teamOnlineCount === "number" ? ` · ${teamOnlineCount}` : ""}
            {teamRole ? ` · ${teamRole}` : ""}
          </span>
        )}
        {readOnlyWorkspace && <span>{t("team.readOnlyBadge")}</span>}
        {activeFile && <span>{activeFile.language.toUpperCase()}</span>}
        <span>UTF-8</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
          style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: connected ? "var(--success)" : "var(--danger)",
            }}
          />
          {connected ? t("statusBar.aiConnected") : t("statusBar.aiOffline")}
        </span>
      </div>
    </div>
  );
};
