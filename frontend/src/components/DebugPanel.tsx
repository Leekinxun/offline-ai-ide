import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Bug, CircleDot, Play, RefreshCw, Square, X } from "lucide-react";
import { useDebugger, type DebugFrame } from "../hooks/useDebugger";
import { useI18n } from "../i18n";

interface DebugPanelProps {
  visible: boolean;
  token: string;
  activeFilePath: string | null;
  cursorLine: number;
  breakpointsByPath: Record<string, number[]>;
  onToggleBreakpoint: (path: string, line: number) => void;
  startRequest?: { id: number; path: string } | null;
  onOpenLocation: (frame: DebugFrame) => void;
  onClose: () => void;
}

function debugRuntime(path: string): "node" | "python" | null {
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return "node";
  if (/\.pyw?$/i.test(path)) return "python";
  return null;
}

export const DebugPanel: React.FC<DebugPanelProps> = ({ visible, token, activeFilePath, cursorLine, breakpointsByPath, onToggleBreakpoint, startRequest, onOpenLocation, onClose }) => {
  const { t } = useI18n();
  const debug = useDebugger(token, visible);
  const [targetPath, setTargetPath] = useState("");
  const handledStartRequestRef = useRef(0);
  const active = debug.session && ["starting", "running", "paused"].includes(debug.session.status);
  const targetRuntime = useMemo(() => debugRuntime(targetPath), [targetPath]);
  const breakpoints = breakpointsByPath[targetPath] || [];
  const supported = targetRuntime !== null;

  useEffect(() => {
    if (!active && activeFilePath && debugRuntime(activeFilePath)) setTargetPath(activeFilePath);
  }, [active, activeFilePath]);
  useEffect(() => {
    if (debug.session?.path) {
      setTargetPath(debug.session.path);
    }
  }, [debug.session?.id]);
  useEffect(() => {
    if (!startRequest || startRequest.id === handledStartRequestRef.current) return;
    handledStartRequestRef.current = startRequest.id;
    setTargetPath(startRequest.path);
    void debug.start(startRequest.path, breakpointsByPath[startRequest.path] || []);
  }, [breakpointsByPath, debug.start, startRequest]);
  if (!visible) return null;

  const toggleBreakpoint = () => {
    if (!activeFilePath || activeFilePath !== targetPath) return;
    onToggleBreakpoint(targetPath, cursorLine);
  };
  const status = debug.session?.status || "stopped";
  const statusLabel = status === "starting"
    ? t(debug.session?.runtime === "python" ? "debug.status.startingPython" : "debug.status.startingNode")
    : t(`debug.status.${status}`);

  return <aside className="debug-panel panel-shell workspace-drawer" aria-label={t("debug.aria")} tabIndex={-1} data-workspace-drawer="debug">
    <div className="workbench-panel-header"><div className="workbench-panel-title"><Bug size={15} /><strong>{t("debug.title")}</strong></div><div className="workbench-panel-actions"><button type="button" className="sidebar-action-btn" onClick={() => void debug.refresh()} title={t("common.refresh")}><RefreshCw size={14} /></button><button type="button" className="sidebar-action-btn" onClick={onClose} title={t("common.close")}><X size={14} /></button></div></div>
    {(debug.error || debug.session?.error) && <div className="workbench-panel-error" role="alert">{debug.error || debug.session?.error}</div>}
    <div className="debug-launch">
      <label><span>{t("debug.target")}</span><input value={targetPath} onChange={(event) => setTargetPath(event.target.value)} disabled={!!active} placeholder="src/main.py" /></label>
      <div className="debug-launch-actions">
        <button type="button" className="dialog-btn" onClick={toggleBreakpoint} disabled={!!active || activeFilePath !== targetPath}><CircleDot size={12} />{t("debug.toggleBreakpoint", { line: cursorLine })}</button>
        {active ? <button type="button" className="dialog-btn danger" onClick={() => void debug.stop()} disabled={debug.busy}><Square size={12} />{t("debug.stop")}</button> : <button type="button" className="dialog-btn primary" onClick={() => void debug.start(targetPath, breakpoints)} disabled={debug.busy || !supported} title={!targetPath ? t("debug.noTarget") : undefined}><Play size={12} />{t("debug.start")}</button>}
      </div>
      {!targetPath && <small className="debug-hint is-info">{t("debug.noTarget")}</small>}
      {!supported && targetPath && <small className="debug-hint">{t("debug.supportedTargets")}</small>}
    </div>
    <div className={`debug-status status-${status}`}>
      <span className="chat-run-status-dot" />
      {statusLabel}
      {debug.session && <span className="debug-runtime-badge">{t(`debug.runtime.${debug.session.runtime}`)}</span>}
    </div>
    {breakpoints.length > 0 && <div className="debug-section"><strong>{t("debug.breakpoints")}</strong><div className="debug-breakpoints">{breakpoints.map((line) => <button type="button" key={line} onClick={() => !active && onToggleBreakpoint(targetPath, line)}><CircleDot size={11} /><code>{targetPath}:{line}</code></button>)}</div></div>}
    {debug.session?.status === "paused" && <div className="debug-controls"><button type="button" onClick={() => void debug.command("continue")} title={t("debug.continue")}><Play size={14} /></button><button type="button" onClick={() => void debug.command("step_over")} title={t("debug.stepOver")}><ArrowRight size={14} /></button><button type="button" onClick={() => void debug.command("step_into")} title={t("debug.stepInto")}><ArrowDown size={14} /></button><button type="button" onClick={() => void debug.command("step_out")} title={t("debug.stepOut")}><ArrowUp size={14} /></button></div>}
    {debug.session?.frames.length ? <div className="debug-section debug-stack"><strong>{t("debug.callStack")}</strong>{debug.session.frames.map((frame) => { const navigable = !!frame.path && !/^(?:node:|https?:|webpack:|<|\/|[A-Za-z]:[\\/])/.test(frame.path); return <button type="button" key={frame.id} onClick={() => navigable && onOpenLocation(frame)} disabled={!navigable}><span>{frame.functionName}</span><code>{frame.path || "runtime"}:{frame.line}</code></button>; })}</div> : null}
    {debug.session && <div className="debug-console"><div className="debug-console-header"><strong>{t("debug.console")}</strong><span>{statusLabel}</span></div><pre className="run-output debug-output">{[debug.session.stdout, debug.session.stderr].filter(Boolean).join("\n") || t("runCenter.noOutput")}</pre></div>}
  </aside>;
};
