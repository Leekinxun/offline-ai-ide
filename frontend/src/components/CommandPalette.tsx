import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Bot, Bug, CircleAlert, Command, FileCode2, GitBranch, History, Search, Settings, ShieldCheck, Sparkles, TerminalSquare, TestTube2, Users, WandSparkles, X, Plus } from "lucide-react";
import { FileNode } from "../types";
import { useI18n } from "../i18n";
import { useModalDialogFocus } from "./useModalDialogFocus";
import "./CommandPalette.css";

export type CommandPaletteMode = "commands" | "files";

interface CommandPaletteProps {
  visible: boolean;
  mode: CommandPaletteMode;
  tree: FileNode[];
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onRunCommand: (command: string) => void;
  canFormatDocument: boolean;
}

interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
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
  canFormatDocument,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialogFocus<HTMLDivElement>({ open: visible, onClose, initialFocusRef: inputRef });

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
          description: file.path,
          icon: <FileCode2 size={16} />,
          action: () => onOpenFile(file.path),
        }));
    }

    const commands: PaletteItem[] = [
      ...(canFormatDocument ? [{
        id: "format-document",
        label: t("command.formatDocument"),
        shortcut: "Shift+Alt+F",
        description: "格式化当前打开的代码文件",
        icon: <WandSparkles size={16} />,
        action: () => onRunCommand("format-document"),
      }] : []),
      {
        id: "focus",
        label: t("command.focusMode"),
        description: t("command.focusModeHint"),
        icon: <Sparkles size={16} />,
        action: () => onRunCommand("focus"),
      },
      {
        id: "explorer",
        label: t("command.toggleExplorer"),
        shortcut: "Ctrl+B",
        description: "打开或隐藏侧边资源管理器",
        icon: <Search size={16} />,
        action: () => onRunCommand("explorer"),
      },
      {
        id: "terminal",
        label: t("command.toggleTerminal"),
        shortcut: "Ctrl+`",
        description: "打开或折叠内置交互终端",
        icon: <TerminalSquare size={16} />,
        action: () => onRunCommand("terminal"),
      },
      {
        id: "chat",
        label: t("command.toggleChat"),
        shortcut: "Ctrl+J",
        description: "呼出或折叠 AI 对话助手",
        icon: <Command size={16} />,
        action: () => onRunCommand("chat"),
      },
      {
        id: "new-conversation",
        label: t("command.newConversation"),
        shortcut: "Ctrl+Alt+N",
        description: "开启全新 AI 会话任务",
        icon: <Plus size={16} />,
        action: () => onRunCommand("new-conversation"),
      },
      {
        id: "history",
        label: t("command.openTasks"),
        shortcut: "Ctrl+Alt+←/→",
        description: "浏览已完成的历史任务与回溯",
        icon: <History size={16} />,
        action: () => onRunCommand("history"),
      },
      {
        id: "settings",
        label: t("command.openSettings"),
        shortcut: "Ctrl+,",
        description: t("command.openSettingsHint"),
        icon: <Settings size={16} />,
        action: () => onRunCommand("settings"),
      },
      {
        id: "knowledge",
        label: t("command.openKnowledge"),
        description: t("command.openKnowledgeHint"),
        icon: <BookOpen size={16} />,
        action: () => onRunCommand("knowledge"),
      },
      {
        id: "mcp",
        label: t("command.openMcp"),
        description: t("command.openMcpHint"),
        icon: <Bot size={16} />,
        action: () => onRunCommand("mcp"),
      },
      {
        id: "git",
        label: t("command.openGit"),
        shortcut: "Ctrl+Shift+G",
        description: t("command.openGitHint"),
        icon: <GitBranch size={16} />,
        action: () => onRunCommand("git"),
      },
      {
        id: "checkpoints",
        label: t("command.openCheckpoints"),
        description: t("command.openCheckpointsHint"),
        icon: <ShieldCheck size={16} />,
        action: () => onRunCommand("checkpoints"),
      },
      {
        id: "problems",
        label: t("command.openProblems"),
        shortcut: "Ctrl+Shift+M",
        description: "查看代码诊断与静态检查问题",
        icon: <CircleAlert size={16} />,
        action: () => onRunCommand("problems"),
      },
      {
        id: "run-center",
        label: t("command.openRunCenter"),
        description: t("command.openRunCenterHint"),
        icon: <TestTube2 size={16} />,
        action: () => onRunCommand("run-center"),
      },
      {
        id: "debug",
        label: t("command.openDebug"),
        shortcut: "F5",
        description: t("command.openDebugHint"),
        icon: <Bug size={16} />,
        action: () => onRunCommand("debug"),
      },
      {
        id: "agents",
        label: t("command.openAgents"),
        description: t("command.openAgentsHint"),
        icon: <Sparkles size={16} />,
        action: () => onRunCommand("agents"),
      },
      {
        id: "team",
        label: t("command.openTeam"),
        description: t("command.openTeamHint"),
        icon: <Users size={16} />,
        action: () => onRunCommand("team"),
      },
    ];

    return commands.filter((item) =>
      `${item.label} ${item.description || ""} ${item.shortcut || ""}`.toLowerCase().includes(normalized)
    );
  }, [canFormatDocument, mode, onOpenFile, onRunCommand, query, t, tree]);

  const resultsRef = useRef<HTMLDivElement>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(items.length - 1, 0)));
  }, [items.length]);

  // 上下键切换时让当前聚焦项在视窗内可见，解决滚动视窗丢失焦点问题
  useEffect(() => {
    if (selectedIndex < 0 || !resultsRef.current) return;
    const container = resultsRef.current;
    const itemElements = container.querySelectorAll<HTMLElement>(".command-palette-item");
    const targetElement = itemElements[selectedIndex];
    if (targetElement) {
      targetElement.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [selectedIndex]);

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

  // 仅在鼠标物理移动时更新聚焦，彻底杜绝列表滚动时因鼠标静止而误触发焦点抢占与闪烁
  const handleItemMouseMove = (event: React.MouseEvent, index: number) => {
    const { clientX, clientY } = event;
    const dx = Math.abs(clientX - lastMousePosRef.current.x);
    const dy = Math.abs(clientY - lastMousePosRef.current.y);
    if (dx > 2 || dy > 2) {
      lastMousePosRef.current = { x: clientX, y: clientY };
      if (selectedIndex !== index) {
        setSelectedIndex(index);
      }
    }
  };

  return (
    <div className="command-palette-overlay" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? t("command.quickOpen") : t("command.commandPalette")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette-input-row">
          <span className="command-palette-search-icon" aria-hidden="true">
            {mode === "files" ? <Search size={20} strokeWidth={2} /> : <Command size={20} strokeWidth={2} />}
          </span>
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
            <X size={16} />
          </button>
        </div>
        <div ref={resultsRef} className="command-palette-results">
          {items.length === 0 ? (
            <div className="command-palette-empty">{t("command.noResults")}</div>
          ) : (
            items.map((item, index) => {
              const isSelected = index === selectedIndex;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`command-palette-item${isSelected ? " active" : ""}`}
                  onMouseMove={(e) => handleItemMouseMove(e, index)}
                  onClick={() => {
                    item.action();
                    onClose();
                  }}
                >
                  <span className="command-palette-item-icon">{item.icon}</span>
                  <span className="command-palette-item-copy">
                    <span className="command-palette-item-label">{item.label}</span>
                    {item.description && (
                      <span className="command-palette-item-desc">{item.description}</span>
                    )}
                  </span>
                  {item.shortcut && (
                    <kbd className="command-palette-item-kbd">{item.shortcut}</kbd>
                  )}
                  {isSelected && <span className="command-palette-enter">↵</span>}
                </button>
              );
            })
          )}
        </div>
        <div className="command-palette-footer">
          <div className="command-palette-footer-shortcuts">
            <span><kbd>↑</kbd><kbd>↓</kbd> {t("command.navigate")}</span>
            <span><kbd>↵</kbd> {t("command.select")}</span>
            <span><kbd>Esc</kbd> {t("command.close")}</span>
          </div>
          <div className="command-palette-footer-count">
            {items.length} 项
          </div>
        </div>
      </div>
    </div>
  );
};

