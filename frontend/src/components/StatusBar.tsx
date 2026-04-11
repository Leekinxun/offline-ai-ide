import React from "react";

interface StatusBarProps {
  activeFile: { path: string; language: string } | null;
  cursorPosition: { line: number; column: number };
  connected: boolean;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  activeFile,
  cursorPosition,
  connected,
}) => {
  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {activeFile && (
          <>
            <span>{activeFile.path}</span>
            <span>
              Ln {cursorPosition.line}, Col {cursorPosition.column}
            </span>
          </>
        )}
      </div>
      <div className="statusbar-right">
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
          {connected ? "AI Connected" : "AI Offline"}
        </span>
      </div>
    </div>
  );
};
