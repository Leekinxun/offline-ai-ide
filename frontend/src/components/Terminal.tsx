import React, { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RotateCw, TerminalSquare, Trash2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "../i18n";
import { PanelHeader, PanelState } from "./PanelChrome";

interface TerminalProps {
  visible: boolean;
  token: string;
  disabled?: boolean;
  disabledReason?: string | null;
  drawerMode?: boolean;
  onClose?: () => void;
  style?: React.CSSProperties;
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const disconnectLabelRef = useRef(t("terminal.disconnected"));

  disconnectLabelRef.current = t("terminal.disconnected");

  // Initialize xterm only when first visible and container exists
  useEffect(() => {
    if (disabled) return;
    if (!visible || initialized.current || !containerRef.current) return;
    initialized.current = true;
    setConnecting(true);

    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2563eb";

    const xterm = new XTerm({
      theme: {
        background: "#1d1d1f",
        foreground: "#d4d4d4",
        cursor: accent,
        cursorAccent: "#1d1d1f",
        selectionBackground: "rgba(37, 99, 235, 0.3)",
        black: "#1d1d1f",
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

    setTimeout(() => fitAddon.fit(), 100);

    // Connect WebSocket
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/terminal?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      setConnected(true);
      setConnecting(false);
      xterm.focus();
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
      setConnected(false);
      setConnecting(false);
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

    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(handleResize)
      : null;
    if (resizeObserver && panelRef.current) {
      resizeObserver.observe(panelRef.current);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
      ws.close();
      setConnected(false);
      setConnecting(false);
      xterm.dispose();
      initialized.current = false;
    };
  }, [connectionGeneration, disabled, token, visible]);

  // Re-fit when toggled back to visible
  useEffect(() => {
    if (disabled) return;
    if (visible && fitAddonRef.current && xtermRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
        xtermRef.current?.focus();
      }, 100);
    }
  }, [disabled, visible]);

  // Always render DOM so ref exists; toggle with display
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
      onKeyDownCapture={(event) => {
        if (drawerMode && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose?.();
        }
      }}
    >
      <PanelHeader
        titleId="terminal-panel-title"
        icon={<TerminalSquare size={15} />}
        title={t("terminal.title")}
        status={disabled ? t("terminal.readOnly") : connecting ? t("terminal.connecting") : connected ? t("terminal.connected") : t("terminal.offline")}
        statusTone={disabled ? "warning" : connected ? "success" : connecting ? "working" : "danger"}
        closeLabel={t("common.close")}
        onClose={onClose}
        actions={
          <>
            <button
              type="button"
              className="sidebar-action-btn"
              onClick={() => xtermRef.current?.clear()}
              title={t("terminal.clear")}
              aria-label={t("terminal.clear")}
              disabled={!connected}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
            {!disabled && !connected && !connecting && (
              <button
                type="button"
                className="sidebar-action-btn"
                onClick={() => setConnectionGeneration((value) => value + 1)}
                title={t("terminal.reconnect")}
                aria-label={t("terminal.reconnect")}
              >
                <RotateCw size={14} aria-hidden="true" />
              </button>
            )}
          </>
        }
      />
      {disabled ? (
        <PanelState
          tone="disabled"
          icon={<TerminalSquare size={26} />}
          title={t("terminal.readOnly")}
          detail={disabledReason || t("terminal.readOnlyDisabled")}
        />
      ) : (
        <div className="terminal-body" ref={containerRef} role="region" aria-label={t("terminal.session")} />
      )}
    </div>
  );
};
