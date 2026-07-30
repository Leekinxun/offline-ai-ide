import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Bug, ChevronDown, ChevronRight, CircleDot, Play, RefreshCw, Send, Square, X } from "lucide-react";
import { useDebugger, type DebugFrame, type DebugScope, type DebugVariable } from "../hooks/useDebugger";
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
  onActiveFrameChange: (frame: DebugFrame | null) => void;
  onClose: () => void;
}

interface ConsoleEntry { expression: string; result?: string; type?: string; error?: string; }

function debugRuntime(path: string): "node" | "python" | null {
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return "node";
  if (/\.pyw?$/i.test(path)) return "python";
  return null;
}

const VariableNode: React.FC<{
  variable: DebugVariable;
  loadVariables: (reference: number) => Promise<DebugVariable[]>;
}> = ({ variable, loadVariables }) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DebugVariable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reference = variable.variablesReference || 0;
  const expandable = reference > 0;

  const toggle = async () => {
    if (!expandable) return;
    const next = !expanded;
    setExpanded(next);
    if (!next || children) return;
    setError(null);
    try { setChildren(await loadVariables(reference)); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
  };

  return <li className="debug-variable-node">
    <button type="button" className="debug-variable-row" onClick={() => void toggle()} disabled={!expandable} aria-expanded={expandable ? expanded : undefined}>
      <span className="debug-variable-chevron">{expandable ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}</span>
      <code className="debug-variable-name">{variable.name}</code>
      <span className="debug-variable-value" title={variable.value}>{variable.value}</span>
      {variable.type && <span className="debug-variable-type">{variable.type}</span>}
    </button>
    {error && <div className="debug-variable-error">{error}</div>}
    {expanded && children && <ul>{children.map((child, index) => <VariableNode key={`${child.name}:${index}`} variable={child} loadVariables={loadVariables} />)}</ul>}
  </li>;
};

const ScopeNode: React.FC<{
  scope: DebugScope;
  loadVariables: (reference: number) => Promise<DebugVariable[]>;
}> = ({ scope, loadVariables }) => {
  const [expanded, setExpanded] = useState(!scope.expensive);
  const [variables, setVariables] = useState<DebugVariable[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || variables) return;
    let cancelled = false;
    setError(null);
    void loadVariables(scope.variablesReference)
      .then((items) => { if (!cancelled) setVariables(items); })
      .catch((nextError) => { if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError)); });
    return () => { cancelled = true; };
  }, [expanded, loadVariables, scope.variablesReference, variables]);

  return <div className="debug-scope">
    <button type="button" className="debug-scope-header" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{scope.name}</strong>
    </button>
    {error && <div className="debug-variable-error">{error}</div>}
    {expanded && variables && <ul className="debug-variable-tree">{variables.map((variable, index) => <VariableNode key={`${variable.name}:${index}`} variable={variable} loadVariables={loadVariables} />)}</ul>}
  </div>;
};

export const DebugPanel: React.FC<DebugPanelProps> = ({ visible, token, activeFilePath, cursorLine, breakpointsByPath, onToggleBreakpoint, startRequest, onOpenLocation, onActiveFrameChange, onClose }) => {
  const { t } = useI18n();
  const debug = useDebugger(token, visible);
  const [targetPath, setTargetPath] = useState("");
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [scopes, setScopes] = useState<DebugScope[]>([]);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [expression, setExpression] = useState("");
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [evaluating, setEvaluating] = useState(false);
  const handledStartRequestRef = useRef(0);
  const announcedPauseRef = useRef("");
  const scopeRequestRef = useRef(0);
  const active = debug.session && ["starting", "running", "paused"].includes(debug.session.status);
  const targetRuntime = useMemo(() => debugRuntime(targetPath), [targetPath]);
  const breakpoints = breakpointsByPath[targetPath] || [];
  const supported = targetRuntime !== null;
  const selectedFrame = debug.session?.frames.find((frame) => frame.id === selectedFrameId) || null;

  useEffect(() => {
    if (!active && activeFilePath && debugRuntime(activeFilePath)) setTargetPath(activeFilePath);
  }, [active, activeFilePath]);
  useEffect(() => { if (debug.session?.path) setTargetPath(debug.session.path); }, [debug.session?.id, debug.session?.path]);
  useEffect(() => {
    if (!startRequest || startRequest.id === handledStartRequestRef.current) return;
    handledStartRequestRef.current = startRequest.id;
    setTargetPath(startRequest.path);
    void debug.start(startRequest.path, breakpointsByPath[startRequest.path] || []);
  }, [breakpointsByPath, debug.start, startRequest]);
  useEffect(() => {
    setConsoleEntries([]);
    setExpression("");
  }, [debug.session?.id]);
  useEffect(() => {
    if (debug.session?.status !== "paused" || !debug.session.frames.length) {
      setSelectedFrameId(null);
      setScopes([]);
      onActiveFrameChange(null);
      return;
    }
    const top = debug.session.frames[0];
    const pauseKey = `${debug.session.id}:${debug.session.pauseVersion}`;
    if (announcedPauseRef.current === pauseKey) return;
    announcedPauseRef.current = pauseKey;
    setSelectedFrameId(top.id);
    onActiveFrameChange(top);
    onOpenLocation(top);
  }, [debug.session?.id, debug.session?.status, debug.session?.pauseVersion, debug.session?.frames, onActiveFrameChange, onOpenLocation]);
  useEffect(() => {
    if (debug.session?.status !== "paused" || !selectedFrameId) { setScopes([]); return; }
    const request = ++scopeRequestRef.current;
    setScopeError(null);
    setScopes([]);
    void debug.loadScopes(selectedFrameId)
      .then((items) => { if (request === scopeRequestRef.current) setScopes(items); })
      .catch((nextError) => { if (request === scopeRequestRef.current) setScopeError(nextError instanceof Error ? nextError.message : String(nextError)); });
  }, [debug.loadScopes, debug.session?.status, debug.session?.pauseVersion, selectedFrameId]);
  if (!visible) return null;

  const toggleBreakpoint = () => {
    if (!activeFilePath || activeFilePath !== targetPath) return;
    onToggleBreakpoint(targetPath, cursorLine);
  };
  const selectFrame = (frame: DebugFrame) => {
    setSelectedFrameId(frame.id);
    onActiveFrameChange(frame);
    onOpenLocation(frame);
  };
  const submitExpression = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextExpression = expression.trim();
    if (!nextExpression || !selectedFrameId || debug.session?.status !== "paused") return;
    setExpression("");
    setEvaluating(true);
    try {
      const result = await debug.evaluate(nextExpression, selectedFrameId);
      setConsoleEntries((items) => [...items, { expression: nextExpression, result: result.result, type: result.type }]);
    } catch (nextError) {
      setConsoleEntries((items) => [...items, { expression: nextExpression, error: nextError instanceof Error ? nextError.message : String(nextError) }]);
    } finally { setEvaluating(false); }
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
    <div className={`debug-status status-${status}`}><span className="chat-run-status-dot" />{statusLabel}{debug.session && <span className="debug-runtime-badge">{t(`debug.runtime.${debug.session.runtime}`)}</span>}</div>
    {breakpoints.length > 0 && <div className="debug-section"><strong>{t("debug.breakpoints")}</strong><div className="debug-breakpoints">{breakpoints.map((line) => <button type="button" key={line} onClick={() => !active && onToggleBreakpoint(targetPath, line)}><CircleDot size={11} /><code>{targetPath}:{line}</code></button>)}</div></div>}
    {debug.session?.status === "paused" && <div className="debug-controls"><button type="button" disabled={debug.busy} onClick={() => void debug.command("continue")} title={t("debug.continue")}><Play size={14} /></button><button type="button" disabled={debug.busy} onClick={() => void debug.command("step_over")} title={t("debug.stepOver")}><ArrowRight size={14} /></button><button type="button" disabled={debug.busy} onClick={() => void debug.command("step_into")} title={t("debug.stepInto")}><ArrowDown size={14} /></button><button type="button" disabled={debug.busy} onClick={() => void debug.command("step_out")} title={t("debug.stepOut")}><ArrowUp size={14} /></button></div>}
    {debug.session?.frames.length ? <div className="debug-section debug-stack"><strong>{t("debug.callStack")}</strong>{debug.session.frames.map((frame) => { const navigable = !!frame.path && !/^(?:node:|https?:|webpack:|<|\/|[A-Za-z]:[\\/])/.test(frame.path); return <button type="button" className={frame.id === selectedFrameId ? "active" : ""} key={frame.id} onClick={() => navigable && selectFrame(frame)} disabled={!navigable}><span>{frame.functionName}</span><code>{frame.path || "runtime"}:{frame.line}</code></button>; })}</div> : null}
    {debug.session?.status === "paused" && <div className="debug-section debug-variables"><strong>{t("debug.variables")}</strong>{scopeError && <div className="debug-variable-error" role="alert">{scopeError}</div>}{!scopeError && scopes.length === 0 && <small>{t("debug.noVariables")}</small>}{scopes.map((scope, index) => <ScopeNode key={`${scope.name}:${index}`} scope={scope} loadVariables={debug.loadVariables} />)}</div>}
    {debug.session && <div className="debug-console"><div className="debug-console-header"><strong>{t("debug.console")}</strong><span>{statusLabel}</span></div><pre className="run-output debug-output">{[debug.session.stdout, debug.session.stderr].filter(Boolean).join("\n") || t("runCenter.noOutput")}</pre><div className="debug-repl-history">{consoleEntries.map((entry, index) => <div key={`${entry.expression}:${index}`} className={entry.error ? "debug-repl-entry is-error" : "debug-repl-entry"}><code>› {entry.expression}</code><span>{entry.error || entry.result}{entry.type ? ` (${entry.type})` : ""}</span></div>)}</div><form className="debug-repl-form" onSubmit={(event) => void submitExpression(event)}><input value={expression} onChange={(event) => setExpression(event.target.value)} placeholder={t("debug.evaluatePlaceholder")} disabled={debug.session.status !== "paused" || evaluating || !selectedFrame} aria-label={t("debug.evaluatePlaceholder")} /><button type="submit" disabled={debug.session.status !== "paused" || evaluating || !selectedFrame || !expression.trim()} title={t("debug.evaluate")}><Send size={13} /></button></form></div>}
  </aside>;
};
