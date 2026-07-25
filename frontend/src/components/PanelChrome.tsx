import React from "react";
import { RefreshCw, X } from "lucide-react";

export type PanelStatusTone = "neutral" | "working" | "success" | "warning" | "danger";

interface PanelHeaderProps {
  titleId: string;
  icon: React.ReactNode;
  title: string;
  status?: string;
  statusTone?: PanelStatusTone;
  refreshing?: boolean;
  refreshLabel?: string;
  closeLabel?: string;
  onRefresh?: () => void;
  onClose?: () => void;
  actions?: React.ReactNode;
}

export const PanelHeader: React.FC<PanelHeaderProps> = ({
  titleId,
  icon,
  title,
  status,
  statusTone = "neutral",
  refreshing = false,
  refreshLabel,
  closeLabel,
  onRefresh,
  onClose,
  actions,
}) => (
  <div className="panel-chrome-header">
    <div className="panel-chrome-heading">
      <span className="panel-chrome-icon" aria-hidden="true">{icon}</span>
      <strong id={titleId}>{title}</strong>
      {status && (
        <span className={`panel-chrome-status tone-${statusTone}`} aria-live="polite">
          <i aria-hidden="true" />
          {status}
        </span>
      )}
    </div>
    <div className="panel-chrome-actions">
      {actions}
      {onRefresh && refreshLabel && (
        <button
          type="button"
          className="sidebar-action-btn"
          onClick={onRefresh}
          title={refreshLabel}
          aria-label={refreshLabel}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? "chat-spin" : ""} aria-hidden="true" />
        </button>
      )}
      {onClose && closeLabel && (
        <button
          type="button"
          className="sidebar-action-btn panel-chrome-close"
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  </div>
);

interface PanelStateProps {
  tone?: "neutral" | "loading" | "error" | "disabled";
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const PanelState: React.FC<PanelStateProps> = ({
  tone = "neutral",
  icon,
  title,
  detail,
  actionLabel,
  onAction,
}) => (
  <div
    className={`panel-state tone-${tone}`}
    role={tone === "error" ? "alert" : "status"}
    aria-live={tone === "error" ? "assertive" : "polite"}
  >
    {icon && <span className="panel-state-icon" aria-hidden="true">{icon}</span>}
    <strong>{title}</strong>
    {detail && <span>{detail}</span>}
    {actionLabel && onAction && (
      <button type="button" className="panel-state-action" onClick={onAction}>
        {actionLabel}
      </button>
    )}
  </div>
);
