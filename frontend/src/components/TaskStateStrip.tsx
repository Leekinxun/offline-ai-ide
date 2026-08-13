import React from "react";
import { useI18n } from "../i18n";
import "./TaskStateStrip.css";

export type TaskStateTone = "neutral" | "running" | "success" | "warning" | "danger";

interface TaskStateStripProps {
  requested: string;
  running: string;
  evidence: string;
  action: string;
  runningTone?: TaskStateTone;
  evidenceTone?: TaskStateTone;
  actionTone?: TaskStateTone;
  onAction?: () => void;
  actionDisabled?: boolean;
  actionDisabledReason?: string;
  compact?: boolean;
}

export const TaskStateStrip: React.FC<TaskStateStripProps> = ({
  requested,
  running,
  evidence,
  action,
  runningTone = "neutral",
  evidenceTone = "neutral",
  actionTone = "neutral",
  onAction,
  actionDisabled = false,
  actionDisabledReason,
  compact = false,
}) => {
  const { t } = useI18n();
  const items = [
    { id: "requested", value: requested, tone: "neutral" as TaskStateTone },
    { id: "running", value: running, tone: runningTone },
    { id: "evidence", value: evidence, tone: evidenceTone },
  ];
  return (
    <section className={`task-state-strip${compact ? " compact" : ""}`} aria-label={t("taskState.summary")}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {`${t("taskState.requested")}: ${requested}. ${t("taskState.running")}: ${running}. ${t("taskState.evidence")}: ${evidence}. ${t("taskState.action")}: ${action}.`}
      </span>
      <dl>
        {items.map((item) => (
          <div className={`task-state-cell tone-${item.tone}`} key={item.id}>
            <dt>{t(`taskState.${item.id}`)}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
        <div className={`task-state-cell task-state-action tone-${actionTone}`}>
          <dt>{t("taskState.action")}</dt>
          <dd>
            {onAction ? (
              <button type="button" onClick={onAction} disabled={actionDisabled} aria-disabled={actionDisabled || undefined} title={actionDisabled ? actionDisabledReason : undefined}>
                {action}
              </button>
            ) : <span>{action}</span>}
            {actionDisabled && actionDisabledReason && <small>{actionDisabledReason}</small>}
          </dd>
        </div>
      </dl>
    </section>
  );
};
