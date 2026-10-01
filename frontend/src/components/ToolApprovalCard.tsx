import React, { useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../types";
import { useI18n } from "../i18n";

interface ToolApprovalCardProps {
  request: ToolApprovalRequest;
  onRespond: (approvalId: string, decision: ToolApprovalDecision) => void;
  onRequestRevision?: (request: ToolApprovalRequest, instruction: string) => boolean;
}

export const ToolApprovalCard: React.FC<ToolApprovalCardProps> = ({ request, onRespond, onRequestRevision }) => {
  const { t } = useI18n();
  const isPlanHandoff = request.name === "submit_plan";
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [revisionError, setRevisionError] = useState(false);
  const inputPreview = useMemo(() => {
    const json = JSON.stringify(request.input, null, 2);
    return json;
  }, [request.input]);

  return (
    <section className={`tool-approval-card risk-${request.risk}`} aria-live="assertive">
      <div className="tool-approval-heading">
        <span className="tool-approval-icon"><ShieldAlert size={16} /></span>
        <div>
          <strong>{t(isPlanHandoff ? "chat.approval.planTitle" : "chat.approval.title")}</strong>
          <span>{t(`chat.approval.risk.${request.risk}`)} · <code>{request.name}</code></span>
        </div>
      </div>
      <p>{request.reason}</p>
      {request.input.allow_network === true && <p className="tool-approval-network">{t("chat.approval.networkNotice")}</p>}
      <div className="tool-approval-scope">
        <span>{t("chat.approval.scope")}</span>
        <code>{request.scope}</code>
      </div>
      {isPlanHandoff && <div className="plan-approval-content">
        {(["goal", "files", "steps", "risks", "verification_commands", "acceptance_criteria"] as const).map((field) => {
          const value = request.input[field];
          const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
          return <section key={field}>
            <strong>{t(`planCard.${field}`)}</strong>
            <ol>{entries.map((entry, index) => <li key={index}>{String(entry)}</li>)}</ol>
          </section>;
        })}
      </div>}
      <details className="tool-approval-details">
        <summary>{t("chat.approval.arguments")}</summary>
        <pre>{inputPreview}</pre>
      </details>
      {isPlanHandoff && onRequestRevision && <div className="plan-revision-input">
        <textarea aria-label={t("planCard.revision")} placeholder={t("planCard.revision")} value={revisionInstruction} onChange={(event) => setRevisionInstruction(event.target.value)} />
        <button type="button" disabled={!revisionInstruction.trim()} onClick={() => setRevisionError(!onRequestRevision(request, revisionInstruction.trim()))}>{t("planCard.requestRevision")}</button>
        {revisionError && <p role="alert">{t("planCard.revisionFailed")}</p>}
      </div>}
      <div className="tool-approval-actions">
        <button type="button" className="tool-approval-deny" onClick={() => onRespond(request.approvalId, "deny")}>
          {t(isPlanHandoff ? "chat.approval.rejectPlan" : "chat.approval.deny")}
        </button>
        {request.canAllowSession && (
          <button type="button" onClick={() => onRespond(request.approvalId, "allow_session")}>
            {t("chat.approval.allowSession")}
          </button>
        )}
        <button type="button" className="tool-approval-allow" onClick={() => onRespond(request.approvalId, "allow_once")} autoFocus>
          {t(isPlanHandoff ? "chat.approval.approvePlan" : "chat.approval.allowOnce")}
        </button>
      </div>
    </section>
  );
};
