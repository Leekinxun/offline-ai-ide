import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, RotateCw, TerminalSquare, Trash2, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";
import { useI18n } from "../i18n";
import { PanelHeader, PanelState } from "./PanelChrome";
import { useModalDialogFocus } from "./useModalDialogFocus";

interface TerminalProps {
  visible: boolean;
  token: string;
  disabled?: boolean;
  disabledReason?: string | null;
  drawerMode?: boolean;
  onClose?: () => void;
  style?: React.CSSProperties;
}

interface TerminalSession {
  id: string;
  title: string;
}

interface TerminalStatus {
  connected: boolean;
  connecting: boolean;
}

interface TerminalInstanceHandle {
  clear: () => void;
  reconnect: () => void;
  fit: () => void;
  focus: () => void;
}

interface TerminalInstanceProps {
  id: string;
  token: string;
  active: boolean;
  visible: boolean;
  disabled: boolean;
  onStatusChange: (status: TerminalStatus) => void;
  registerHandle: (id: string, handle: TerminalInstanceHandle | null) => void;
}

/** 单个独立的终端会话实例 */
const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  id,
  token,
  active,
  visible,
  disabled,
  onStatusChange,
  registerHandle,
}) => {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initialized = useRef(false);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const disconnectLabelRef = useRef(t("terminal.disconnected"));

  disconnectLabelRef.current = t("terminal.disconnected");

  // 注册当前实例的控制句柄供外部操作栏调用
  useEffect(() => {
    registerHandle(id, {
      clear: () => xtermRef.current?.clear(),
      reconnect: () => setConnectionGeneration((val) => val + 1),
      fit: () => {
        try {
          fitAddonRef.current?.fit();
        } catch {}
      },
      focus: () => xtermRef.current?.focus(),
    });
    return () => {
      registerHandle(id, null);
    };
  }, [id, registerHandle]);

  // 初始化 xterm 与 WebSocket
  useEffect(() => {
    if (disabled || !containerRef.current) return;
    initialized.current = true;
    onStatusChange({ connected: false, connecting: true });

    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2563eb";

    const xterm = new XTerm({
      theme: {
        background: "#101722",
        foreground: "#d4d4d4",
        cursor: accent,
        cursorAccent: "#101722",
        selectionBackground: "rgba(37, 99, 235, 0.3)",
        black: "#101722",
        red: "#ff3b30",
        green: "#34c759",
        yellow: "#ff9500",
        blue: accent,
        magenta: "#af52de",
        cyan: "#5ac8fa",
        white: "#d4d4d4",
        brightBlack: "#6e6e73",
        brightRed: "#ff6961",
        brightGreen: "#4cd964",
        brightYellow: "#ffcc00",
        brightBlue: "#5ac8fa",
        brightMagenta: "#da70d6",
        brightCyan: "#70d7ff",
        brightWhite: "#ffffff",
      },
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);

    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch {}
    }, 100);

    // 连接专属后台 WebSocket PTY 进程
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/terminal?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      onStatusChange({ connected: true, connecting: false });
      if (active) xterm.focus();
      ws.send(
        JSON.stringify({
          type: "resize",
          rows: xterm.rows,
          cols: xterm.cols,
        })
      );
    };

    ws.onmessage = (event) => {
      xterm.write(event.data);
    };

    ws.onclose = () => {
      onStatusChange({ connected: false, connecting: false });
      xterm.write(`\r\n\x1b[90m${disconnectLabelRef.current}\x1b[0m\r\n`);
    };

    xterm.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    xterm.onResize(({ rows, cols }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", rows, cols }));
      }
    });

    xtermRef.current = xterm;
    wsRef.current = ws;
    fitAddonRef.current = fitAddon;

    let rafId: number | null = null;
    const handleResize = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {}
      });
    };

    window.addEventListener("resize", handleResize);
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(handleResize) : null;
    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
      ws.close();
      onStatusChange({ connected: false, connecting: false });
      xterm.dispose();
      initialized.current = false;
    };
  }, [connectionGeneration, disabled, id, token]);

  // 当切换到该终端或整体面板恢复显示时，重新 fit 与获取焦点
  useEffect(() => {
    if (disabled) return;
    if (active && visible && fitAddonRef.current && xtermRef.current) {
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          xtermRef.current?.focus();
        } catch {}
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [active, disabled, visible]);

  return (
    <div
      ref={containerRef}
      className="terminal-instance-container"
      style={{ display: active ? "block" : "none" }}
      role="tabpanel"
      aria-labelledby={`terminal-tab-${id}`}
      aria-label={t("terminal.session")}
    />
  );
};

export const Terminal: React.FC<TerminalProps> = ({
  visible,
  token,
  disabled = false,
  disabledReason,
  drawerMode = false,
  onClose,
  style,
}) => {
  const { t } = useI18n();
  const panelRef = useModalDialogFocus<HTMLDivElement>({
    open: visible && drawerMode,
    onClose: onClose || (() => undefined),
  });

  // 多会话管理状态
  const [sessions, setSessions] = useState<TerminalSession[]>(() => [
    { id: "term-default", title: t("terminal.tabTitle", { index: 1 }) },
  ]);
  const [activeSessionId, setActiveSessionId] = useState<string>("term-default");
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, TerminalStatus>>({});
  const sessionHandles = useRef<Map<string, TerminalInstanceHandle>>(new Map());

  // 重命名编辑状态
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const registerHandle = useCallback((id: string, handle: TerminalInstanceHandle | null) => {
    if (handle) {
      sessionHandles.current.set(id, handle);
    } else {
      sessionHandles.current.delete(id);
    }
  }, []);

  const handleStatusChange = useCallback((id: string, status: TerminalStatus) => {
    setSessionStatuses((prev) => ({
      ...prev,
      [id]: status,
    }));
  }, []);

  // 新建终端会话
  const handleCreateSession = useCallback(() => {
    if (disabled) return;
    const newId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newTitle = t("terminal.tabTitle", { index: sessions.length + 1 });
    setSessions((prev) => [...prev, { id: newId, title: newTitle }]);
    setActiveSessionId(newId);
  }, [disabled, sessions.length, t]);

  // 关闭指定终端会话
  const handleCloseSession = useCallback(
    (idToClose: string) => {
      if (sessions.length <= 1) return;
      const index = sessions.findIndex((s) => s.id === idToClose);
      if (index === -1) return;

      const nextSessions = sessions.filter((s) => s.id !== idToClose);
      setSessions(nextSessions);

      // 清除状态
      setSessionStatuses((prev) => {
        const copy = { ...prev };
        delete copy[idToClose];
        return copy;
      });

      // 若关闭的是当前激活项，则切换到邻近的会话
      if (activeSessionId === idToClose) {
        const nextActiveIndex = Math.max(0, index - 1);
        setActiveSessionId(nextSessions[nextActiveIndex].id);
      }
    },
    [activeSessionId, sessions]
  );

  // 清空当前激活终端
  const handleClear = useCallback(() => {
    sessionHandles.current.get(activeSessionId)?.clear();
  }, [activeSessionId]);

  // 重新连接当前激活终端
  const handleReconnect = useCallback(() => {
    sessionHandles.current.get(activeSessionId)?.reconnect();
  }, [activeSessionId]);

  // 键盘快捷键导航标签页
  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowRight") {
      const next = (index + 1) % sessions.length;
      setActiveSessionId(sessions[next].id);
    } else if (e.key === "ArrowLeft") {
      const prev = (index - 1 + sessions.length) % sessions.length;
      setActiveSessionId(sessions[prev].id);
    } else if (e.key === "Home") {
      setActiveSessionId(sessions[0].id);
    } else if (e.key === "End") {
      setActiveSessionId(sessions[sessions.length - 1].id);
    }
  };

  const activeStatus = sessionStatuses[activeSessionId] || { connected: false, connecting: false };

  return (
    <div
      ref={panelRef}
      className="terminal-panel panel-shell workspace-drawer"
      style={{ ...style, ...(visible ? undefined : { display: "none" }) }}
      role={drawerMode ? "dialog" : "region"}
      aria-modal={drawerMode || undefined}
      aria-labelledby="terminal-panel-title"
      tabIndex={-1}
      data-workspace-drawer="terminal"
    >
      <PanelHeader
        titleId="terminal-panel-title"
        icon={<TerminalSquare size={15} />}
        title={t("terminal.title")}
        status={
          disabled
            ? t("terminal.readOnly")
            : activeStatus.connecting
            ? t("terminal.connecting")
            : activeStatus.connected
            ? t("terminal.connected")
            : t("terminal.offline")
        }
        statusTone={
          disabled
            ? "warning"
            : activeStatus.connected
            ? "success"
            : activeStatus.connecting
            ? "working"
            : "danger"
        }
        closeLabel={t("common.close")}
        onClose={onClose}
        actions={
          <>
            <button
              type="button"
              className="sidebar-action-btn"
              onClick={handleCreateSession}
              title={t("terminal.new")}
              aria-label={t("terminal.new")}
              disabled={disabled}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="sidebar-action-btn"
              onClick={handleClear}
              title={t("terminal.clear")}
              aria-label={t("terminal.clear")}
              disabled={!activeStatus.connected}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
            {!disabled && !activeStatus.connected && !activeStatus.connecting && (
              <button
                type="button"
                className="sidebar-action-btn"
                onClick={handleReconnect}
                title={t("terminal.reconnect")}
                aria-label={t("terminal.reconnect")}
              >
                <RotateCw size={14} aria-hidden="true" />
              </button>
            )}
          </>
        }
      />

      {/* 终端会话多标签切换栏 */}
      {!disabled && (
        <div className="terminal-tabs-strip" role="tablist" aria-label={t("terminal.session")}>
          <div className="terminal-tabs-track">
            {sessions.map((session, index) => {
              const isCurrentActive = session.id === activeSessionId;
              const status = sessionStatuses[session.id] || { connected: false, connecting: false };
              const toneClass = status.connected ? "tone-success" : status.connecting ? "tone-working" : "tone-danger";

              return (
                <div
                  key={session.id}
                  id={`terminal-tab-${session.id}`}
                  role="tab"
                  aria-selected={isCurrentActive}
                  tabIndex={isCurrentActive ? 0 : -1}
                  className={`terminal-tab-pill ${isCurrentActive ? "active" : ""}`}
                  onClick={() => setActiveSessionId(session.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, index)}
                  onDoubleClick={() => {
                    setEditingSessionId(session.id);
                    setEditingTitle(session.title);
                  }}
                >
                  <span className={`terminal-tab-dot ${toneClass}`} aria-hidden="true" />
                  {editingSessionId === session.id ? (
                    <input
                      type="text"
                      className="terminal-tab-rename-input"
                      value={editingTitle}
                      autoFocus
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => {
                        if (editingTitle.trim()) {
                          setSessions((prev) =>
                            prev.map((s) => (s.id === session.id ? { ...s, title: editingTitle.trim() } : s))
                          );
                        }
                        setEditingSessionId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          if (editingTitle.trim()) {
                            setSessions((prev) =>
                              prev.map((s) => (s.id === session.id ? { ...s, title: editingTitle.trim() } : s))
                            );
                          }
                          setEditingSessionId(null);
                        } else if (e.key === "Escape") {
                          setEditingSessionId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="terminal-tab-title">{session.title}</span>
                  )}
                  {sessions.length > 1 && (
                    <button
                      type="button"
                      className="terminal-tab-close-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseSession(session.id);
                      }}
                      title={t("terminal.closeSession")}
                      aria-label={t("terminal.closeSession")}
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="terminal-new-tab-btn"
            onClick={handleCreateSession}
            title={t("terminal.new")}
            aria-label={t("terminal.new")}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {disabled ? (
        <PanelState
          tone="disabled"
          icon={<TerminalSquare size={26} />}
          title={t("terminal.readOnly")}
          detail={disabledReason || t("terminal.readOnlyDisabled")}
        />
      ) : (
        <div className="terminal-viewports-container" role="region" aria-label={t("terminal.session")}>
          {sessions.map((session) => (
            <TerminalInstance
              key={session.id}
              id={session.id}
              token={token}
              active={session.id === activeSessionId}
              visible={visible}
              disabled={disabled}
              onStatusChange={(status) => handleStatusChange(session.id, status)}
              registerHandle={registerHandle}
            />
          ))}
        </div>
      )}
    </div>
  );
};
