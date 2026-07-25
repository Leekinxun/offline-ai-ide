import React, { useMemo } from "react";
import { ShieldAlert } from "lucide-react";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../types";
import { useI18n } from "../i18n";

interface ToolApprovalCardProps {
  request: ToolApprovalRequest;
  onRespond: (approvalId: string, decision: ToolApprovalDecision) => void;
}

export const ToolApprovalCard: React.FC<ToolApprovalCardProps> = ({ request, onRespond }) => {
  const { t } = useI18n();
  const inputPreview = useMemo(() => {
    const json = JSON.stringify(request.input, null, 2);
    return json.length > 1200 ? `${json.slice(0, 1200)}\n…` : json;
  }, [request.input]);

  return (
    <section className={`tool-approval-card risk-${request.risk}`} aria-live="assertive">
      <div className="tool-approval-heading">
        <span className="tool-approval-icon"><ShieldAlert size={16} /></span>
        <div>
          <strong>{t("chat.approval.title")}</strong>
          <span>{t(`chat.approval.risk.${request.risk}`)} · <code>{request.name}</code></span>
        </div>
      </div>
      <p>{request.reason}</p>
      <div className="tool-approval-scope">
        <span>{t("chat.approval.scope")}</span>
        <code>{request.scope}</code>
      </div>
      <details className="tool-approval-details">
        <summary>{t("chat.approval.arguments")}</summary>
        <pre>{inputPreview}</pre>
      </details>
      <div className="tool-approval-actions">
        <button type="button" className="tool-approval-deny" onClick={() => onRespond(request.approvalId, "deny")}>
          {t("chat.approval.deny")}
        </button>
        {request.canAllowSession && (
          <button type="button" onClick={() => onRespond(request.approvalId, "allow_session")}>
            {t("chat.approval.allowSession")}
          </button>
        )}
        <button type="button" className="tool-approval-allow" onClick={() => onRespond(request.approvalId, "allow_once")} autoFocus>
          {t("chat.approval.allowOnce")}
        </button>
      </div>
    </section>
  );
};
