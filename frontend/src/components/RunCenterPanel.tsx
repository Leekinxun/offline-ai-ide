import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleX, LoaderCircle, Play, RefreshCw, Square, TestTube2, X } from "lucide-react";
import { useRunCenter, type RunFailure, type RunRecord } from "../hooks/useRunCenter";
import { useI18n } from "../i18n";

interface RunCenterPanelProps {
  visible: boolean;
  token: string;
  onOpenLocation: (failure: RunFailure) => void;
  onClose: () => void;
  onRunningChange?: (label: string | null) => void;
}

export const RunCenterPanel: React.FC<RunCenterPanelProps> = ({ visible, token, onOpenLocation, onClose, onRunningChange }) => {
  const { t } = useI18n();
  const center = useRunCenter(token, visible);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selected = useMemo(() => center.runs.find((run) => run.id === selectedRunId) || center.runs[0] || null, [center.runs, selectedRunId]);
  useEffect(() => {
    const label = center.runningTaskId ? center.tasks.find((task) => task.id === center.runningTaskId)?.label || t("runCenter.runningTask") : null;
    onRunningChange?.(label);
  }, [center.runningTaskId, center.tasks, onRunningChange, t]);
  if (!visible) return null;

  const runTask = async (taskId: string) => { const record = await center.run(taskId); if (record) setSelectedRunId(record.id); };
  const statusIcon = (run: RunRecord) => run.status === "running" ? <LoaderCircle className="spin" size={13} /> : run.status === "passed" ? <CheckCircle2 size={13} /> : <CircleX size={13} />;

  return <aside className="run-center-panel panel-shell workspace-drawer" aria-label={t("runCenter.aria")} tabIndex={-1} data-workspace-drawer="run-center">
    <div className="workbench-panel-header"><div className="workbench-panel-title"><TestTube2 size={15} /><strong>{t("runCenter.title")}</strong></div><div className="workbench-panel-actions"><button type="button" className="sidebar-action-btn" onClick={() => void center.refresh()} title={t("runCenter.refresh")} aria-label={t("runCenter.refresh")}><RefreshCw size={14} /></button><button type="button" className="sidebar-action-btn" onClick={onClose} title={t("runCenter.close")} aria-label={t("runCenter.close")}><X size={14} /></button></div></div>
    {center.error && <div className="workbench-panel-error" role="alert">{center.error}</div>}
    <div className="run-task-list">
      {center.tasks.map((task) => <div className="run-task-row" key={task.id}><span><strong>{task.label}</strong><small>{task.kind} · {task.source}</small></span>{center.runningTaskId === task.id ? <button type="button" className="dialog-btn danger" onClick={() => { const active = center.runs.find((run) => run.taskId === task.id && run.status === "running"); if (active) void center.stop(active.id); }}><Square size={12} />{t("runCenter.stop")}</button> : <button type="button" className="dialog-btn" onClick={() => void runTask(task.id)} disabled={center.runningTaskId !== null}><Play size={12} />{t("runCenter.run")}</button>}</div>)}
      {center.tasks.length === 0 && <div className="workbench-panel-empty"><TestTube2 size={24} /><strong>{t("runCenter.noTasksTitle")}</strong><span>{t("runCenter.noTasksHint")}</span></div>}
    </div>
    {selected && <div className="run-result">
      <button type="button" className={`run-result-summary status-${selected.status}`} onClick={() => setSelectedRunId(selected.id)}>{statusIcon(selected)}<strong>{selected.label}</strong><span>{selected.status} · {(selected.durationMs / 1000).toFixed(1)}s</span></button>
      {selected.failures.length > 0 && <div className="run-failures">{selected.failures.map((failure, index) => <button type="button" key={`${failure.path}:${failure.line}:${index}`} onClick={() => onOpenLocation(failure)}><code>{failure.path}:{failure.line}</code><span>{failure.message}</span></button>)}</div>}
      <pre className="run-output">{[selected.stdout, selected.stderr].filter(Boolean).join("\n") || t("runCenter.noOutput")}</pre>
    </div>}
  </aside>;
};
