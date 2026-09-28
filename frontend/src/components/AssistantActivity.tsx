import { useEffect, useState } from "react";
import { Activity, ChevronRight } from "lucide-react";
import { useI18n } from "../i18n";
import { selectAssistantActivity } from "../utils/assistantActivity";

export function AssistantActivity(props: Parameters<typeof selectAssistantActivity>[0]) {
  const { t } = useI18n();
  const activity = selectAssistantActivity(props);
  if (!activity) return null;
  return <div className="assistant-activity" data-phase={activity.phase} role="status" aria-live="polite">
    <Activity size={14} aria-hidden="true" />
    <div className="assistant-activity-copy"><strong>{t(activity.labelKey)}</strong><span>{activity.detailKey ? t(activity.detailKey) : activity.detail}</span></div>
  </div>;
}

export function AssistantReasoning({ content, active, variant = "chat" }: { content: string; active: boolean; variant?: "chat" | "editor" }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(active);
  useEffect(() => setExpanded(active), [active]);
  if (!content.trim()) return null;
  return <details className={variant === "editor" ? "editor-assistant-thinking" : "chat-thinking-block"} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="chat-thinking-header">
      <ChevronRight size={14} className={`chat-thinking-chevron${expanded ? " expanded" : ""}`} aria-hidden="true" />
      <span className="chat-thinking-label">{t("chat.thinking")}</span>
      {!expanded && <span className="chat-thinking-preview">{content.trim().slice(0, 100)}</span>}
    </summary>
    <div data-assistant-reasoning={variant} className={variant === "editor" ? "editor-assistant-thinking-content" : "chat-thinking-body"}>{content}</div>
  </details>;
}
