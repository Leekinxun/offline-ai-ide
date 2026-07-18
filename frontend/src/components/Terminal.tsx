import React, { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "../i18n";

interface TerminalProps {
  visible: boolean;
  token: string;
  disabled?: boolean;
  disabledReason?: string | null;
  onClose?: () => void;
  style?: React.CSSProperties;
}

export const Terminal: React.FC<TerminalProps> = ({
  visible,
  token,
  disabled = false,
  disabledReason,
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
  const disconnectLabelRef = useRef(t("terminal.disconnected"));

  disconnectLabelRef.current = t("terminal.disconnected");

  // Initialize xterm only when first visible and container exists
  useEffect(() => {
    if (disabled) return;
    if (!visible || initialized.current || !containerRef.current) return;
    initialized.current = true;

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
      cursorBlink: true,
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
      xterm.dispose();
      initialized.current = false;
    };
  }, [disabled, visible]);

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
      className="terminal-panel panel-shell"
      style={{ ...style, ...(visible ? undefined : { display: "none" }) }}
    >
      <div className="terminal-header">
        <div className="terminal-header-title"><span className="terminal-header-icon">›_</span>{t("terminal.title")}</div>
        <div className="terminal-header-actions">
          <div className={`terminal-header-status${connected ? " connected" : ""}`}>
            <span />
            {disabled ? t("terminal.offline") : connected ? t("terminal.connected") : t("terminal.offline")}
          </div>
          {onClose && (
            <button type="button" className="terminal-close" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {disabled ? (
        <div className="terminal-disabled">
          {disabledReason || t("terminal.readOnlyDisabled")}
        </div>
      ) : (
        <div className="terminal-body" ref={containerRef} />
      )}
    </div>
  );
};
