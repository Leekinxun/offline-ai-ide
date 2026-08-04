import React from "react";
import { ShieldCheck } from "lucide-react";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../types";
import { useI18n } from "../i18n";
import { ToolApprovalCard } from "./ToolApprovalCard";

interface ToolApprovalStackProps {
  requests: ToolApprovalRequest[];
  onRespond: (approvalId: string, decision: ToolApprovalDecision) => void;
  onApproveConversation: (conversationId: string) => void;
  className?: string;
}

export const ToolApprovalStack: React.FC<ToolApprovalStackProps> = ({
  requests,
  onRespond,
  onApproveConversation,
  className,
}) => {
  const { t } = useI18n();
  if (requests.length === 0) return null;

  const firstRequest = requests[0];
  const pendingLabel = t("chat.approval.pendingCount", { count: requests.length });

  return (
    <section
      className={`tool-approval-stack${className ? ` ${className}` : ""}`}
      aria-label={pendingLabel}
    >
      {firstRequest.conversationId && firstRequest.name !== "submit_plan" && (
        <div className="tool-approval-bulk">
          <span>{pendingLabel}</span>
          <button
            type="button"
            onClick={() => onApproveConversation(firstRequest.conversationId!)}
          >
            <ShieldCheck size={14} />
            {t("chat.approval.allowConversation")}
          </button>
        </div>
      )}
      {requests.map((request) => (
        <ToolApprovalCard key={request.approvalId} request={request} onRespond={onRespond} />
      ))}
    </section>
  );
};
