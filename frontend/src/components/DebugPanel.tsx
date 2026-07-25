import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Bug, CircleDot, Play, RefreshCw, Square, X } from "lucide-react";
import { useDebugger, type DebugFrame } from "../hooks/useDebugger";
import { useI18n } from "../i18n";

interface DebugPanelProps {
  visible: boolean;
  token: string;
  activeFilePath: string | null;
  cursorLine: number;
  onOpenLocation: (frame: DebugFrame) => void;
  onClose: () => void;
}

export const DebugPanel: React.FC<DebugPanelProps> = ({ visible, token, activeFilePath, cursorLine, onOpenLocation, onClose }) => {
  const { t } = useI18n();
  const debug = useDebugger(token, visible);
  const [targetPath, setTargetPath] = useState("");
  const [breakpoints, setBreakpoints] = useState<number[]>([]);
  const active = debug.session && ["starting", "running", "paused"].includes(debug.session.status);
  const supported = useMemo(() => /\.(?:js|mjs|cjs)$/i.test(targetPath), [targetPath]);

  useEffect(() => {
    if (!active && activeFilePath && /\.(?:js|mjs|cjs)$/i.test(activeFilePath)) setTargetPath(activeFilePath);
  }, [active, activeFilePath]);
  useEffect(() => {
    if (debug.session?.path) {
      setTargetPath(debug.session.path);
      setBreakpoints(debug.session.breakpoints.map((item) => item.line));
    }
  }, [debug.session?.id]);
  if (!visible) return null;

  const toggleBreakpoint = () => {
    if (!activeFilePath || activeFilePath !== targetPath) return;
    setBreakpoints((previous) => previous.includes(cursorLine) ? previous.filter((line) => line !== cursorLine) : [...previous, cursorLine].sort((a, b) => a - b));
  };

  return <aside className="debug-panel panel-shell workspace-drawer" aria-label={t("debug.aria")} tabIndex={-1} data-workspace-drawer="debug">
    <div className="workbench-panel-header"><div className="workbench-panel-title"><Bug size={15} /><strong>{t("debug.title")}</strong></div><div className="workbench-panel-actions"><button type="button" className="sidebar-action-btn" onClick={() => void debug.refresh()} title={t("common.refresh")}><RefreshCw size={14} /></button><button type="button" className="sidebar-action-btn" onClick={onClose} title={t("common.close")}><X size={14} /></button></div></div>
    {debug.error && <div className="workbench-panel-error" role="alert">{debug.error}</div>}
    <div className="debug-launch">
      <label><span>{t("debug.target")}</span><input value={targetPath} onChange={(event) => { setTargetPath(event.target.value); setBreakpoints([]); }} disabled={!!active} placeholder="src/index.js" /></label>
      <div className="debug-launch-actions">
        <button type="button" className="dialog-btn" onClick={toggleBreakpoint} disabled={!!active || activeFilePath !== targetPath}><CircleDot size={12} />{t("debug.toggleBreakpoint", { line: cursorLine })}</button>
        {active ? <button type="button" className="dialog-btn danger" onClick={() => void debug.stop()} disabled={debug.busy}><Square size={12} />{t("debug.stop")}</button> : <button type="button" className="dialog-btn primary" onClick={() => void debug.start(targetPath, breakpoints)} disabled={debug.busy || !supported}><Play size={12} />{t("debug.start")}</button>}
      </div>
      {!supported && targetPath && <small className="debug-hint">{t("debug.nodeOnly")}</small>}
    </div>
    <div className={`debug-status status-${debug.session?.status || "stopped"}`}><span className="chat-run-status-dot" />{t(`debug.status.${debug.session?.status || "stopped"}`)}</div>
    {breakpoints.length > 0 && <div className="debug-section"><strong>{t("debug.breakpoints")}</strong><div className="debug-breakpoints">{breakpoints.map((line) => <button type="button" key={line} onClick={() => !active && setBreakpoints((previous) => previous.filter((value) => value !== line))}><CircleDot size={11} /><code>{targetPath}:{line}</code></button>)}</div></div>}
    {debug.session?.status === "paused" && <div className="debug-controls"><button type="button" onClick={() => void debug.command("continue")} title={t("debug.continue")}><Play size={14} /></button><button type="button" onClick={() => void debug.command("step_over")} title={t("debug.stepOver")}><ArrowRight size={14} /></button><button type="button" onClick={() => void debug.command("step_into")} title={t("debug.stepInto")}><ArrowDown size={14} /></button><button type="button" onClick={() => void debug.command("step_out")} title={t("debug.stepOut")}><ArrowUp size={14} /></button></div>}
    {debug.session?.frames.length ? <div className="debug-section debug-stack"><strong>{t("debug.callStack")}</strong>{debug.session.frames.map((frame) => { const navigable = !!frame.path && !/^(?:node:|https?:|webpack:)/.test(frame.path); return <button type="button" key={frame.id} onClick={() => navigable && onOpenLocation(frame)} disabled={!navigable}><span>{frame.functionName}</span><code>{frame.path || "runtime"}:{frame.line}</code></button>; })}</div> : null}
    {debug.session && <pre className="run-output debug-output">{[debug.session.stdout, debug.session.stderr].filter(Boolean).join("\n") || t("runCenter.noOutput")}</pre>}
  </aside>;
};
