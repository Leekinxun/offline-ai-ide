import { forwardRef } from "react";
import { ShieldCheck } from "lucide-react";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../types";
import { useI18n } from "../i18n";
import { ToolApprovalCard } from "./ToolApprovalCard";

interface ToolApprovalStackProps {
  requests: ToolApprovalRequest[];
  onRespond: (approvalId: string, decision: ToolApprovalDecision) => void;
  onApproveConversation: (conversationId: string) => void;
  onRequestRevision?: (request: ToolApprovalRequest, instruction: string) => boolean;
  className?: string;
}

export const ToolApprovalStack = forwardRef<HTMLElement, ToolApprovalStackProps>(({
  requests,
  onRespond,
  onApproveConversation,
  onRequestRevision,
  className,
}, ref) => {
  const { t } = useI18n();
  if (requests.length === 0) return null;

  const firstRequest = requests[0];
  const pendingLabel = t("chat.approval.pendingCount", { count: requests.length });

  return (
    <section
      ref={ref}
      id="pending-tool-approvals"
      tabIndex={-1}
      className={`tool-approval-stack${className ? ` ${className}` : ""}`}
      aria-label={pendingLabel}
    >
      {firstRequest.conversationId && firstRequest.name !== "submit_plan" && firstRequest.input.allow_network !== true && (
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
        <ToolApprovalCard key={request.approvalId} request={request} onRespond={onRespond} onRequestRevision={onRequestRevision} />
      ))}
    </section>
  );
});
ToolApprovalStack.displayName = "ToolApprovalStack";
