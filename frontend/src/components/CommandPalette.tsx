import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Bot, Bug, CircleAlert, Command, FileCode2, GitBranch, History, Search, Settings, ShieldCheck, Sparkles, TerminalSquare, TestTube2, Users, X, Plus } from "lucide-react";
import { FileNode } from "../types";
import { useI18n } from "../i18n";

export type CommandPaletteMode = "commands" | "files";

interface CommandPaletteProps {
  visible: boolean;
  mode: CommandPaletteMode;
  tree: FileNode[];
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onRunCommand: (command: string) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  action: () => void;
}

function flattenFiles(nodes: FileNode[], result: FileNode[] = []): FileNode[] {
  for (const node of nodes) {
    if (node.type === "file") result.push(node);
    if (node.children) flattenFiles(node.children, result);
  }
  return result;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  visible,
  mode,
  tree,
  onClose,
  onOpenFile,
  onRunCommand,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setSelectedIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [visible, mode]);

  const items = useMemo<PaletteItem[]>(() => {
    const normalized = query.trim().toLowerCase();
    const files = flattenFiles(tree);

    if (mode === "files") {
      return files
        .filter((file) =>
          !normalized || `${file.name} ${file.path}`.toLowerCase().includes(normalized)
        )
        .slice(0, 80)
        .map((file) => ({
          id: `file:${file.path}`,
          label: file.name,
          hint: file.path,
          icon: <FileCode2 size={15} />,
          action: () => onOpenFile(file.path),
        }));
    }

    const commands: PaletteItem[] = [
      {
        id: "focus",
        label: t("command.focusMode"),
        hint: t("command.focusModeHint"),
        icon: <Sparkles size={15} />,
        action: () => onRunCommand("focus"),
      },
      {
        id: "explorer",
        label: t("command.toggleExplorer"),
        hint: "Cmd/Ctrl+B",
        icon: <Search size={15} />,
        action: () => onRunCommand("explorer"),
      },
      {
        id: "terminal",
        label: t("command.toggleTerminal"),
        hint: "Cmd/Ctrl+`",
        icon: <TerminalSquare size={15} />,
        action: () => onRunCommand("terminal"),
      },
      {
        id: "chat",
        label: t("command.toggleChat"),
        hint: "Cmd/Ctrl+J",
        icon: <Command size={15} />,
        action: () => onRunCommand("chat"),
      },
      {
        id: "new-conversation",
        label: t("command.newConversation"),
        hint: "Cmd/Ctrl+Alt+N",
        icon: <Plus size={15} />,
        action: () => onRunCommand("new-conversation"),
      },
      {
        id: "history",
        label: t("command.openTasks"),
        hint: "Cmd/Ctrl+Alt+←/→",
        icon: <History size={15} />,
        action: () => onRunCommand("history"),
      },
      {
        id: "settings",
        label: t("command.openSettings"),
        hint: t("command.openSettingsHint"),
        icon: <Settings size={15} />,
        action: () => onRunCommand("settings"),
      },
      {
        id: "knowledge",
        label: t("command.openKnowledge"),
        hint: t("command.openKnowledgeHint"),
        icon: <BookOpen size={15} />,
        action: () => onRunCommand("knowledge"),
      },
      {
        id: "mcp",
        label: t("command.openMcp"),
        hint: t("command.openMcpHint"),
        icon: <Bot size={15} />,
        action: () => onRunCommand("mcp"),
      },
      {
        id: "git",
        label: t("command.openGit"),
        hint: t("command.openGitHint"),
        icon: <GitBranch size={15} />,
        action: () => onRunCommand("git"),
      },
      {
        id: "checkpoints",
        label: t("command.openCheckpoints"),
        hint: t("command.openCheckpointsHint"),
        icon: <ShieldCheck size={15} />,
        action: () => onRunCommand("checkpoints"),
      },
      {
        id: "problems",
        label: t("command.openProblems"),
        hint: "Cmd/Ctrl+Shift+M",
        icon: <CircleAlert size={15} />,
        action: () => onRunCommand("problems"),
      },
      {
        id: "run-center",
        label: t("command.openRunCenter"),
        hint: t("command.openRunCenterHint"),
        icon: <TestTube2 size={15} />,
        action: () => onRunCommand("run-center"),
      },
      {
        id: "debug",
        label: t("command.openDebug"),
        hint: t("command.openDebugHint"),
        icon: <Bug size={15} />,
        action: () => onRunCommand("debug"),
      },
      {
        id: "agents",
        label: t("command.openAgents"),
        hint: t("command.openAgentsHint"),
        icon: <Sparkles size={15} />,
        action: () => onRunCommand("agents"),
      },
      {
        id: "team",
        label: t("command.openTeam"),
        hint: t("command.openTeamHint"),
        icon: <Users size={15} />,
        action: () => onRunCommand("team"),
      },
    ];

    return commands.filter((item) =>
      `${item.label} ${item.hint}`.toLowerCase().includes(normalized)
    );
  }, [mode, onOpenFile, onRunCommand, query, t, tree]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(items.length - 1, 0)));
  }, [items.length]);

  if (!visible) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => (current + 1) % Math.max(items.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => (current - 1 + items.length) % Math.max(items.length, 1));
    } else if (event.key === "Enter" && items[selectedIndex]) {
      event.preventDefault();
      items[selectedIndex].action();
      onClose();
    }
  };

  return (
    <div className="command-palette-overlay" onMouseDown={onClose}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label={mode === "files" ? t("command.quickOpen") : t("command.commandPalette")} onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-palette-input-row">
          {mode === "files" ? <Search size={17} /> : <Command size={17} />}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={mode === "files" ? t("command.quickOpenPlaceholder") : t("command.searchPlaceholder")}
            aria-label={mode === "files" ? t("command.quickOpen") : t("command.commandPalette")}
          />
          <button type="button" className="command-palette-close" onClick={onClose} title={t("common.cancel")}>
            <X size={15} />
          </button>
        </div>
        <div className="command-palette-results">
          {items.length === 0 ? (
            <div className="command-palette-empty">{t("command.noResults")}</div>
          ) : (
            items.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={`command-palette-item${index === selectedIndex ? " active" : ""}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => {
                  item.action();
                  onClose();
                }}
              >
                <span className="command-palette-item-icon">{item.icon}</span>
                <span className="command-palette-item-copy">
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </span>
                {index === selectedIndex && <span className="command-palette-enter">↵</span>}
              </button>
            ))
          )}
        </div>
        <div className="command-palette-footer">
          <span>↑↓ {t("command.navigate")}</span>
          <span>Enter {t("command.select")}</span>
          <span>Esc {t("command.close")}</span>
        </div>
      </div>
    </div>
  );
};
