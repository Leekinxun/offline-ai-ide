import React, { useState } from "react";
import { Bot, Clock3, Pause, Play, RotateCcw, Send, ShieldAlert, Sparkles, Square, UserRoundCog } from "lucide-react";
import { AgentControlAction, AgentSnapshot, canUpdateAgentBudget } from "../types";
import { useI18n } from "../i18n";
import { useAgents } from "../hooks/useAgents";
import { PanelHeader, PanelState } from "./PanelChrome";
import { TaskStateStrip } from "./TaskStateStrip";
import { useModalDialogFocus } from "./useModalDialogFocus";

interface AgentBoardProps { visible: boolean; token: string; onClose: () => void; drawerMode?: boolean; }
const formatTime = (value?: number) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
function statusIcon(status: AgentSnapshot["status"]) { return status === "working" || status === "finalizing" ? <Sparkles size={14} /> : status === "paused" ? <Pause size={13} /> : status === "blocked" || status === "failed" || status === "interrupted" || status === "orphaned" ? <ShieldAlert size={14} /> : status === "idle" || status === "awaiting_review" ? <Clock3 size={14} /> : <Square size={12} />; }

export const AgentBoard: React.FC<AgentBoardProps> = ({ visible, token, onClose, drawerMode = false }) => {
  const { t } = useI18n();
  const { agents, loading, error, refresh, control, updateBudget, pendingById } = useAgents(token, visible);
  const panelRef = useModalDialogFocus<HTMLElement>({ open: visible && drawerMode, onClose });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [steering, setSteering] = useState<Record<string, string>>({});
  const [assignments, setAssignments] = useState<Record<string, { prompt: string; role: string }>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, Record<string, string>>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const workingCount = agents.filter((agent) => agent.status === "working").length;
  const evidenceCount = agents.reduce((total, agent) => total + (agent.metrics?.toolCalls || 0) + (agent.blockers?.length || 0), 0);
  if (!visible) return null;
  const keyFor = (agent: AgentSnapshot) => agent.id || agent.name;
  const execute = async (agent: AgentSnapshot, action: AgentControlAction, payload: { instruction?: string; prompt?: string; role?: string } = {}) => {
    setActionError(null);
    try { await control(agent, action, payload); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : t("agents.controlUnavailable")); }
  };
  const saveBudget = async (agent: AgentSnapshot, budget: Record<string, number>) => {
    setActionError(null);
    try { await updateBudget(agent, budget); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : t("agents.controlUnavailable")); }
  };

  return <aside ref={panelRef} className="agent-board panel-shell workspace-drawer" role={drawerMode ? "dialog" : "complementary"} aria-modal={drawerMode || undefined} aria-labelledby="agent-board-title" tabIndex={-1} data-workspace-drawer="agents">
    <PanelHeader titleId="agent-board-title" icon={<Bot size={16} />} title={t("agents.title")} status={loading && !agents.length ? t("common.loading") : t("agents.statusSummary", { count: workingCount })} statusTone={workingCount ? "working" : error ? "danger" : "neutral"} refreshing={loading} refreshLabel={t("common.refresh")} closeLabel={t("common.close")} onRefresh={() => void refresh()} onClose={onClose} />
    <div className="agent-board-summary" aria-live="polite"><span className="agent-summary-item working"><i aria-hidden="true" /><strong>{workingCount}</strong>{t("agents.working")}</span><span className="agent-summary-item"><strong>{agents.length}</strong>{t("agents.total")}</span></div>
    <TaskStateStrip requested={t("agents.requestedState", { count: agents.length })} running={workingCount ? t("chat.taskStatus.running") : t("taskState.ready")} runningTone={workingCount ? "running" : "neutral"} evidence={evidenceCount ? t("taskState.evidenceCount", { count: evidenceCount }) : t("taskState.noEvidence")} evidenceTone={evidenceCount ? "success" : "neutral"} action={agents.length ? t("agents.inspectAgent") : t("common.refresh")} onAction={() => { const first = agents[0]; if (first) setExpanded(keyFor(first)); else void refresh(); }} compact />
    {loading && !agents.length && !error && <PanelState tone="loading" icon={<Sparkles size={24} />} title={t("agents.loadingTitle")} detail={t("agents.loadingHint")} />}
    {error && <PanelState tone="error" icon={<Bot size={24} />} title={t("agents.failed")} detail={error} actionLabel={t("common.refresh")} onAction={() => void refresh()} />}
    {actionError && <div className="delivery-inline-error" role="alert">{actionError}</div>}
    {!loading && !error && !agents.length && <PanelState icon={<Bot size={28} />} title={t("agents.emptyTitle")} detail={t("agents.emptyHint")} />}
    <div className="agent-board-list" role="list" aria-label={t("agents.title")}>{agents.map((agent) => {
      const key = keyFor(agent), pending = pendingById[key], isExpanded = expanded === key, canPause = agent.status === "working", canResume = agent.status === "paused" || agent.status === "blocked";
      return <article className={`agent-card status-${agent.status}`} key={key} role="listitem" aria-label={`${agent.name}: ${t(`agents.status.${agent.status}`)}`}>
        <button type="button" className="agent-card-head agent-card-disclosure" onClick={() => setExpanded(isExpanded ? null : key)} aria-expanded={isExpanded}><span className="agent-card-name"><span className="agent-status-icon" aria-hidden="true">{statusIcon(agent.status)}</span><strong>{agent.name}</strong></span><span className="agent-status-label">{t(`agents.status.${agent.status}`)}</span></button>
        <div className="agent-card-role">{agent.role}{agent.version ? ` · ${agent.version}` : ""}</div><div className="agent-card-task">{agent.currentTask || t("agents.noCurrentTask")}</div>
        {isExpanded && <div className="agent-card-detail">
          {agent.capabilities?.length ? <p><b>{t("agents.capabilities")}</b>{agent.capabilities.join(", ")}</p> : null}
          {agent.budget && <p><b>{t("agents.budget")}</b>{[
            agent.budget.maxConcurrentAgents ? t("agents.budgetAgents", { count: agent.budget.maxConcurrentAgents }) : "",
            agent.budget.maxTokens ? t("agents.budgetTokens", { count: agent.budget.maxTokens }) : "",
            agent.budget.maxCostUsd !== undefined ? t("agents.budgetCost", { value: agent.budget.maxCostUsd }) : "",
            agent.budget.maxDurationMs ? t("agents.budgetDuration", { value: Math.round(agent.budget.maxDurationMs / 60000) }) : "",
          ].filter(Boolean).join(" · ")}</p>}
          {canUpdateAgentBudget(agent) && <fieldset className="agent-budget-editor"><legend>{t("agents.editBudget")}</legend>{(["maxConcurrentAgents", "maxTokens", "maxCostUsd", "maxDurationMs"] as const).map((field) => <label key={field}>{t(`agents.budgetField.${field}`)}<input type="number" min="0" step={field === "maxCostUsd" ? "0.01" : "1"} value={budgetDrafts[key]?.[field] ?? agent.budget?.[field] ?? ""} onChange={(event) => setBudgetDrafts((current) => ({ ...current, [key]: { ...current[key], [field]: event.target.value } }))} /></label>)}<button type="button" disabled={Boolean(pending)} onClick={() => { const draft = budgetDrafts[key] || {}; const budget = Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== "").map(([field, value]) => [field, Number(value)])); void saveBudget(agent, budget); }}>{t("common.save")}</button></fieldset>}
          {agent.metrics && <p><b>{t("agents.metrics")}</b>{agent.metrics.toolCalls ?? 0} {t("workbench.toolCalls")} · {agent.metrics.totalTokens ?? 0} {t("agents.tokens")}</p>}
          {agent.blockers?.map((blocker) => <p className="agent-blocker" key={blocker}><ShieldAlert size={12} />{blocker}</p>)}
          {agent.canManageBudget === true && <><div className="agent-control-row"><button disabled={Boolean(pending) || !canPause} onClick={() => void execute(agent, "pause")}><Pause size={12} />{t("agents.pause")}</button><button disabled={Boolean(pending) || !canResume} onClick={() => void execute(agent, "resume")}><Play size={12} />{t("agents.resume")}</button><button disabled={Boolean(pending)} onClick={() => void execute(agent, "stop")}><Square size={11} />{t("agents.stop")}</button><button disabled={Boolean(pending)} onClick={() => void execute(agent, "retry")}><RotateCcw size={12} />{t("agents.retry")}</button></div>
          <label className="agent-steer"><span>{t("agents.steer")}</span><textarea value={steering[key] || ""} onChange={(event) => setSteering((value) => ({ ...value, [key]: event.target.value }))} placeholder={t("agents.steerPlaceholder")} /><button disabled={Boolean(pending) || !(steering[key] || "").trim()} onClick={() => { void execute(agent, "steer", { instruction: steering[key] }); setSteering((value) => ({ ...value, [key]: "" })); }}><Send size={12} />{t("agents.sendSteer")}</button></label>
          <fieldset className="agent-assignment"><legend>{t("agents.assignment")}</legend><label>{t("agents.assignmentPrompt")}<textarea value={assignments[key]?.prompt || ""} onChange={(event) => setAssignments((current) => ({ ...current, [key]: { role: current[key]?.role || agent.role, prompt: event.target.value } }))} placeholder={t("agents.assignmentPlaceholder")} /></label><label>{t("agents.assignmentRole")}<input value={assignments[key]?.role ?? agent.role} onChange={(event) => setAssignments((current) => ({ ...current, [key]: { prompt: current[key]?.prompt || "", role: event.target.value } }))} /></label><div className="agent-control-row"><button disabled={Boolean(pending) || !(assignments[key]?.prompt || "").trim()} onClick={() => void execute(agent, "reassign", { prompt: assignments[key].prompt.trim() })}><UserRoundCog size={12} />{t("agents.reassign")}</button><button disabled={Boolean(pending) || !(assignments[key]?.prompt || "").trim() || !(assignments[key]?.role || agent.role).trim()} onClick={() => void execute(agent, "replace", { prompt: assignments[key].prompt.trim(), role: (assignments[key].role || agent.role).trim() })}><UserRoundCog size={12} />{t("agents.replace")}</button></div></fieldset></>}
        </div>}
        {agent.updatedAt && <div className="agent-card-time">{t("agents.updatedAt", { time: formatTime(agent.updatedAt) })}</div>}
      </article>;
    })}</div>
  </aside>;
};
