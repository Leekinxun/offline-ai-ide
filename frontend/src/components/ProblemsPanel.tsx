import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, Info, Pause, Play, RefreshCw, X } from "lucide-react";
import type { EditorProblem } from "../hooks/useEditorProblems";
import { useDiagnostics, type WorkspaceDiagnostic } from "../hooks/useDiagnostics";
import { useI18n } from "../i18n";
import { TaskStateStrip } from "./TaskStateStrip";

type Problem = WorkspaceDiagnostic & { id: string };

interface ProblemsPanelProps {
  visible: boolean;
  token: string;
  editorProblems: EditorProblem[];
  onOpenLocation: (problem: Problem) => void;
  onClose: () => void;
  onCountsChange?: (counts: { errors: number; warnings: number }) => void;
}

function icon(severity: Problem["severity"]) {
  if (severity === "error") return <AlertCircle size={14} />;
  if (severity === "warning") return <AlertTriangle size={14} />;
  return <Info size={14} />;
}

export const ProblemsPanel: React.FC<ProblemsPanelProps> = ({ visible, token, editorProblems, onOpenLocation, onClose, onCountsChange }) => {
  const { t } = useI18n();
  const diagnostics = useDiagnostics(token, visible);
  const [filter, setFilter] = useState<"all" | Problem["severity"]>("all");
  const allProblems = useMemo<Problem[]>(() => {
    const values: Problem[] = [
      ...editorProblems.map((problem) => ({ ...problem, id: problem.id })),
      ...diagnostics.diagnostics.map((problem, index) => ({ ...problem, id: `workspace:${problem.path}:${problem.line}:${problem.column}:${index}` })),
    ];
    const seen = new Set<string>();
    return values.filter((problem) => {
      const key = `${problem.path}:${problem.line}:${problem.column}:${problem.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [diagnostics.diagnostics, editorProblems]);
  const combined = useMemo(
    () => allProblems.filter((problem) => filter === "all" || problem.severity === filter),
    [allProblems, filter]
  );
  useEffect(() => {
    onCountsChange?.({
      errors: allProblems.filter((problem) => problem.severity === "error").length,
      warnings: allProblems.filter((problem) => problem.severity === "warning").length,
    });
  }, [allProblems, onCountsChange]);

  if (!visible) return null;
  const counts = (severity: Problem["severity"]) => allProblems.filter((item) => item.severity === severity).length;

  return <aside className="problems-panel panel-shell workspace-drawer" role="complementary" aria-label={t("problems.title")} tabIndex={-1} data-workspace-drawer="problems" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <div className="workbench-panel-header">
      <div className="workbench-panel-title"><AlertCircle size={15} /><strong>{t("problems.title")}</strong></div>
      <div className="workbench-panel-actions">
        <button className="sidebar-action-btn" type="button" onClick={() => void (diagnostics.session.status === "stopped" ? diagnostics.startWatching() : diagnostics.stopWatching())} title={t(diagnostics.session.status === "stopped" ? "problems.startWatching" : "problems.stopWatching")} aria-label={t(diagnostics.session.status === "stopped" ? "problems.startWatching" : "problems.stopWatching")}>{diagnostics.session.status === "stopped" ? <Play size={14} /> : <Pause size={14} />}</button>
        <button className="sidebar-action-btn" type="button" onClick={() => void diagnostics.refresh()} title={t("problems.refresh")} aria-label={t("problems.refresh")}><RefreshCw size={14} className={diagnostics.running ? "chat-spin" : ""} /></button>
        <button className="sidebar-action-btn" type="button" onClick={onClose} title={t("problems.close")} aria-label={t("problems.close")}><X size={14} /></button>
      </div>
    </div>
    <TaskStateStrip requested={t("problems.validationRequest")} running={t(`problems.session.${diagnostics.session.status}`)} runningTone={diagnostics.running ? "running" : diagnostics.error ? "danger" : "neutral"} evidence={allProblems.length ? t("taskState.evidenceCount", { count: allProblems.length }) : t("taskState.noEvidence")} evidenceTone={counts("error") ? "danger" : allProblems.length ? "warning" : "success"} action={t(diagnostics.session.status === "stopped" ? "problems.startWatching" : "problems.stopWatching")} actionTone={diagnostics.session.status === "stopped" ? "neutral" : "warning"} onAction={() => void (diagnostics.session.status === "stopped" ? diagnostics.startWatching() : diagnostics.stopWatching())} compact />
    <div className="problems-toolbar" role="group" aria-label={t("problems.filter")}> 
      {(["all", "error", "warning", "info"] as const).map((value) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{t(`problems.${value}`)}{value !== "all" ? ` ${counts(value)}` : ""}</button>)}
    </div>
    <div className={`problems-watch-state status-${diagnostics.session.status}`}><span className="chat-run-status-dot" />{t(`problems.session.${diagnostics.session.status}`)}{diagnostics.session.generation > 0 ? ` · #${diagnostics.session.generation}` : ""}</div>
    {diagnostics.tools.length > 0 && <div className="problems-sources">{t("problems.checkedBy", { tools: diagnostics.tools.join(" · "), duration: diagnostics.durationMs })}</div>}
    {diagnostics.error && <div className="workbench-panel-error" role="alert">{diagnostics.error}</div>}
    {!diagnostics.running && combined.length === 0 && <div className="workbench-panel-empty"><AlertCircle size={24} /><strong>{t("problems.emptyTitle")}</strong><span>{t("problems.emptyHint")}</span></div>}
    <div className="problems-list">
      {combined.map((problem) => <button type="button" className={`problem-row severity-${problem.severity}`} key={problem.id} onClick={() => onOpenLocation(problem)}>
        <span className="problem-icon">{icon(problem.severity)}</span>
        <span className="problem-copy"><strong>{problem.message}</strong><small>{problem.path}:{problem.line}:{problem.column} · {problem.source}{problem.code ? ` ${problem.code}` : ""}</small></span>
      </button>)}
    </div>
  </aside>;
};
