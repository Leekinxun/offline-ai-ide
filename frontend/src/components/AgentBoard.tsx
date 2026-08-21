import React, { useMemo, useState } from "react";
import { Bot, Boxes, ChevronUp, Clock3, GitBranch, Pause, Play, RotateCcw, Send, ShieldAlert, Sparkles, Square, UserRoundCog } from "lucide-react";
import { AgentControlAction, AgentGraphBlockingReason, AgentGraphNode, AgentSnapshot, canUpdateAgentBudget } from "../types";
import { useI18n } from "../i18n";
import { useAgents } from "../hooks/useAgents";
import { PanelHeader, PanelState } from "./PanelChrome";
import { TaskStateStrip } from "./TaskStateStrip";
import { useModalDialogFocus } from "./useModalDialogFocus";

interface AgentBoardProps { visible: boolean; token: string; onClose: () => void; drawerMode?: boolean; }
const formatTime = (value?: number) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const safeStatus = (status?: string) => (status || "unknown").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "unknown";
const isCoreNode = (node: AgentGraphNode) => node.kind === "agent" || node.kind === "task" || node.kind === "run" || node.kind === "unresolved_parent";
const blockingReasons: AgentGraphBlockingReason[] = ["waiting_on_children", "child_failed", "awaiting_change_set_review"];
const nodeBlockingReasons = (node: AgentGraphNode) => blockingReasons.filter((reason) => node.blockingReasons?.includes(reason));
function statusIcon(status?: string) { return status === "working" || status === "running" || status === "finalizing" ? <Sparkles size={14} /> : status === "paused" ? <Pause size={13} /> : status === "blocked" || status === "failed" || status === "interrupted" || status === "orphaned" || status === "missing" || status === "cycle" ? <ShieldAlert size={14} /> : <Clock3 size={13} />; }

export const AgentBoard: React.FC<AgentBoardProps> = ({ visible, token, onClose, drawerMode = false }) => {
  const { t } = useI18n();
  const { agents, graph, loading, error, socketConnected, refresh, control, updateBudget, pendingById } = useAgents(token, visible);
  const panelRef = useModalDialogFocus<HTMLElement>({ open: visible && drawerMode, onClose });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [steering, setSteering] = useState<Record<string, string>>({});
  const [assignments, setAssignments] = useState<Record<string, { prompt: string; role: string }>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, Record<string, string>>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const model = useMemo(() => {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const parent = new Map<string, string>();
    const children = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const source = nodes.get(edge.source), target = nodes.get(edge.target);
      if (!source || !target || !isCoreNode(source) || !isCoreNode(target) || (edge.kind !== "spawned_by" && edge.kind !== "owns_task")) continue;
      if (!parent.has(target.id)) parent.set(target.id, source.id);
      const list = children.get(source.id) || []; if (!list.includes(target.id)) children.set(source.id, [...list, target.id]);
    }
    const roots = graph.nodes.filter((node) => isCoreNode(node) && !parent.has(node.id));
    const artifacts = new Map<string, AgentGraphNode[]>();
    const artifactChildren = new Map<string, AgentGraphNode[]>();
    for (const edge of graph.edges) {
      const artifact = nodes.get(edge.target);
      if (artifact?.kind === "worktree" || artifact?.kind === "change_set") artifactChildren.set(edge.source, [...(artifactChildren.get(edge.source) || []), artifact]);
    }
    for (const node of graph.nodes.filter(isCoreNode)) {
      const direct = artifactChildren.get(node.id) || [];
      const nested = direct.flatMap((artifact) => artifact.kind === "worktree" ? artifactChildren.get(artifact.id) || [] : []);
      artifacts.set(node.id, [...new Map([...direct, ...nested].map((artifact) => [artifact.id, artifact])).values()]);
    }
    return { nodes, parent, children, roots, artifacts };
  }, [graph]);

  const legacyByGraphId = useMemo(() => new Map(agents.flatMap((agent) => {
    const key = agent.id || agent.name;
    return [[`agent:${key}`, agent], [`agent:teammate:${agent.name}`, agent], [`agent:${agent.name}`, agent]] as Array<[string, AgentSnapshot]>;
  })), [agents]);
  const workingCount = agents.filter((agent) => agent.status === "working").length || graph.nodes.filter((node) => node.kind === "agent" && node.status === "working").length;
  const blockers = [...agents.filter((agent) => agent.blockers?.length).map((agent) => `${agent.name} · ${agent.blockers!.length}`), ...graph.nodes.flatMap((node) => nodeBlockingReasons(node).map((reason) => `${t(`agents.node.${node.kind}`)} ${node.ref} · ${t(`agents.blockingReason.${reason}`)}`)), ...graph.nodes.filter((node) => node.kind === "task" && nodeBlockingReasons(node).length === 0 && (node.status === "blocked" || (Array.isArray(node.metadata.blockedBy) && node.metadata.blockedBy.length))).map((node) => `${t("agents.node.task")} ${node.ref}`)];
  const recentEvents = [...graph.events].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
  const keyFor = (agent: AgentSnapshot) => agent.id || agent.name;
  const execute = async (agent: AgentSnapshot, action: AgentControlAction, payload: { instruction?: string; prompt?: string; role?: string } = {}) => { setActionError(null); try { await control(agent, action, payload); } catch (reason) { setActionError(reason instanceof Error ? reason.message : t("agents.controlUnavailable")); } };
  const saveBudget = async (agent: AgentSnapshot, budget: Record<string, number>) => { setActionError(null); try { await updateBudget(agent, budget); } catch (reason) { setActionError(reason instanceof Error ? reason.message : t("agents.controlUnavailable")); } };

  const controls = (agent: AgentSnapshot) => {
    const key = keyFor(agent), pending = pendingById[key], canPause = agent.status === "working", canResume = agent.status === "paused" || agent.status === "blocked";
    if (agent.canManageBudget !== true) return null;
    return <div className="agent-card-detail">
      {agent.budget && <p><b>{t("agents.budget")}</b>{[agent.budget.maxConcurrentAgents ? t("agents.budgetAgents", { count: agent.budget.maxConcurrentAgents }) : "", agent.budget.maxTokens ? t("agents.budgetTokens", { count: agent.budget.maxTokens }) : "", agent.budget.maxCostUsd !== undefined ? t("agents.budgetCost", { value: agent.budget.maxCostUsd }) : "", agent.budget.maxDurationMs ? t("agents.budgetDuration", { value: Math.round(agent.budget.maxDurationMs / 60000) }) : ""].filter(Boolean).join(" · ")}</p>}
      {canUpdateAgentBudget(agent) && <fieldset className="agent-budget-editor"><legend>{t("agents.editBudget")}</legend>{(["maxConcurrentAgents", "maxTokens", "maxCostUsd", "maxDurationMs"] as const).map((field) => <label key={field}>{t(`agents.budgetField.${field}`)}<input type="number" min="0" step={field === "maxCostUsd" ? "0.01" : "1"} value={budgetDrafts[key]?.[field] ?? agent.budget?.[field] ?? ""} onChange={(event) => setBudgetDrafts((current) => ({ ...current, [key]: { ...current[key], [field]: event.target.value } }))} /></label>)}<button type="button" disabled={Boolean(pending)} onClick={() => { const draft = budgetDrafts[key] || {}; void saveBudget(agent, Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== "").map(([field, value]) => [field, Number(value)]))); }}>{t("common.save")}</button></fieldset>}
      <div className="agent-control-row"><button disabled={Boolean(pending) || !canPause} onClick={() => void execute(agent, "pause")}><Pause size={12} />{t("agents.pause")}</button><button disabled={Boolean(pending) || !canResume} onClick={() => void execute(agent, "resume")}><Play size={12} />{t("agents.resume")}</button><button disabled={Boolean(pending)} onClick={() => void execute(agent, "stop")}><Square size={11} />{t("agents.stop")}</button><button disabled={Boolean(pending)} onClick={() => void execute(agent, "retry")}><RotateCcw size={12} />{t("agents.retry")}</button></div>
      <label className="agent-steer"><span>{t("agents.steer")}</span><textarea value={steering[key] || ""} onChange={(event) => setSteering((value) => ({ ...value, [key]: event.target.value }))} placeholder={t("agents.steerPlaceholder")} /><button disabled={Boolean(pending) || !(steering[key] || "").trim()} onClick={() => { void execute(agent, "steer", { instruction: steering[key] }); setSteering((value) => ({ ...value, [key]: "" })); }}><Send size={12} />{t("agents.sendSteer")}</button></label>
      <fieldset className="agent-assignment"><legend>{t("agents.assignment")}</legend><label>{t("agents.assignmentPrompt")}<textarea value={assignments[key]?.prompt || ""} onChange={(event) => setAssignments((current) => ({ ...current, [key]: { role: current[key]?.role || agent.role, prompt: event.target.value } }))} placeholder={t("agents.assignmentPlaceholder")} /></label><label>{t("agents.assignmentRole")}<input value={assignments[key]?.role ?? agent.role} onChange={(event) => setAssignments((current) => ({ ...current, [key]: { prompt: current[key]?.prompt || "", role: event.target.value } }))} /></label><div className="agent-control-row"><button disabled={Boolean(pending) || !(assignments[key]?.prompt || "").trim()} onClick={() => void execute(agent, "reassign", { prompt: assignments[key].prompt.trim() })}><UserRoundCog size={12} />{t("agents.reassign")}</button><button disabled={Boolean(pending) || !(assignments[key]?.prompt || "").trim() || !(assignments[key]?.role || agent.role).trim()} onClick={() => void execute(agent, "replace", { prompt: assignments[key].prompt.trim(), role: (assignments[key].role || agent.role).trim() })}><UserRoundCog size={12} />{t("agents.replace")}</button></div></fieldset>
    </div>;
  };

  const renderNode = (node: AgentGraphNode, depth = 1, seen = new Set<string>()): React.ReactNode => {
    if (seen.has(node.id)) return null;
    const nextSeen = new Set(seen).add(node.id), isExpanded = expanded === node.id, agent = legacyByGraphId.get(node.id);
    const name = node.kind === "agent" && typeof node.metadata.name === "string" ? node.metadata.name : `${t(`agents.node.${node.kind}`)} ${node.ref}`;
    const role = node.kind === "agent" && typeof node.metadata.role === "string" ? node.metadata.role : "";
    const parent = model.parent.get(node.id), artifacts = model.artifacts.get(node.id) || [], derivedBlockers = nodeBlockingReasons(node);
    return <li key={node.id} className="agent-tree-item" role="treeitem" aria-level={depth} aria-expanded={isExpanded}>
      <article className={`agent-card status-${safeStatus(node.status)}`}>
        <button type="button" className="agent-card-head agent-card-disclosure" onClick={() => setExpanded(isExpanded ? null : node.id)}><span className="agent-card-name"><span className="agent-status-icon" aria-hidden="true">{statusIcon(node.status)}</span><strong>{name}</strong></span><span className="agent-status-label">{node.status || t("agents.status.unknown")}</span></button>
        <div className="agent-card-role">{role || t(`agents.node.${node.kind}`)}</div>
        {derivedBlockers.length > 0 && <div className="agent-artifact-badges">{derivedBlockers.map((reason) => <span key={reason} className="agent-safe-badge status-blocked"><ShieldAlert size={10} />{t(`agents.blockingReason.${reason}`)}</span>)}</div>}
        <div className="agent-artifact-badges">{artifacts.map((item) => <span key={item.id} className={`agent-safe-badge status-${safeStatus(item.status)}`}><GitBranch size={10} />{t(`agents.node.${item.kind}`)} · {item.status || t("agents.status.unknown")}{item.kind === "change_set" && item.metadata.hasVerificationEvidence === true ? ` · ${t("agents.verified")}` : ""}{item.kind === "change_set" && typeof item.metadata.decision === "string" ? ` · ${t("agents.review")}: ${item.metadata.decision}` : ""}{item.kind === "worktree" && typeof item.metadata.reviewState === "string" ? ` · ${t("agents.review")}: ${item.metadata.reviewState}` : ""}</span>)}</div>
        {isExpanded && <>{parent && <button type="button" className="agent-parent-nav" onClick={() => setExpanded(parent)}><ChevronUp size={12} />{t("agents.goToParent")}</button>}{agent && controls(agent)}</>}
      </article>
      {(model.children.get(node.id)?.length || 0) > 0 && <ul role="group">{model.children.get(node.id)?.map((id) => model.nodes.get(id)).filter((item): item is AgentGraphNode => Boolean(item)).map((child) => renderNode(child, depth + 1, nextSeen))}</ul>}
    </li>;
  };

  if (!visible) return null;
  const hasContent = graph.nodes.length > 0 || agents.length > 0;
  return <aside ref={panelRef} className="agent-board panel-shell workspace-drawer" role={drawerMode ? "dialog" : "complementary"} aria-modal={drawerMode || undefined} aria-labelledby="agent-board-title" tabIndex={-1} data-workspace-drawer="agents">
    <PanelHeader titleId="agent-board-title" icon={<Bot size={16} />} title={t("agents.title")} status={loading && !hasContent ? t("common.loading") : socketConnected ? t("agents.live") : t("agents.fallback")} statusTone={socketConnected ? "working" : error ? "danger" : "neutral"} refreshing={loading} refreshLabel={t("common.refresh")} closeLabel={t("common.close")} onRefresh={() => void refresh()} onClose={onClose} />
    <div className="agent-board-summary" aria-live="polite"><span className="agent-summary-item working"><i aria-hidden="true" /><strong>{workingCount}</strong>{t("agents.working")}</span><span className="agent-summary-item"><strong>{graph.nodes.filter((node) => node.kind === "agent").length || agents.length}</strong>{t("agents.total")}</span><span className="agent-summary-item blockers"><strong>{blockers.length}</strong>{t("agents.blockers")}</span></div>
    <TaskStateStrip requested={t("agents.requestedState", { count: graph.nodes.length || agents.length })} running={workingCount ? t("chat.taskStatus.running") : t("taskState.ready")} runningTone={workingCount ? "running" : "neutral"} evidence={recentEvents.length ? t("taskState.evidenceCount", { count: recentEvents.length }) : t("taskState.noEvidence")} evidenceTone={recentEvents.length ? "success" : "neutral"} action={hasContent ? t("agents.inspectAgent") : t("common.refresh")} onAction={() => { const first = model.roots[0]; if (first) setExpanded(first.id); else void refresh(); }} compact />
    {loading && !hasContent && !error && <PanelState tone="loading" icon={<Sparkles size={24} />} title={t("agents.loadingTitle")} detail={t("agents.loadingHint")} />}
    {error && !hasContent && <PanelState tone="error" icon={<Bot size={24} />} title={t("agents.failed")} detail={error} actionLabel={t("common.refresh")} onAction={() => void refresh()} />}
    {actionError && <div className="delivery-inline-error" role="alert">{actionError}</div>}
    {!loading && !error && !hasContent && <PanelState icon={<Bot size={28} />} title={t("agents.emptyTitle")} detail={t("agents.emptyHint")} />}
    <div className="agent-board-list">
      {blockers.length > 0 && <section className="agent-blocker-summary" aria-labelledby="agent-blockers-title"><h3 id="agent-blockers-title"><ShieldAlert size={13} />{t("agents.blockers")}</h3><ul>{blockers.map((blocker, index) => <li key={`${blocker}:${index}`}>{blocker}</li>)}</ul></section>}
      {graph.nodes.length > 0 ? <ul className="agent-tree" role="tree" aria-label={t("agents.treeLabel")}>{model.roots.map((node) => renderNode(node))}</ul> : <div role="list" aria-label={t("agents.title")}>{agents.map((agent) => <article className={`agent-card status-${safeStatus(agent.status)}`} key={keyFor(agent)} role="listitem"><button type="button" className="agent-card-head agent-card-disclosure" onClick={() => setExpanded(expanded === keyFor(agent) ? null : keyFor(agent))}><span className="agent-card-name">{statusIcon(agent.status)}<strong>{agent.name}</strong></span><span className="agent-status-label">{t(`agents.status.${agent.status}`)}</span></button><div className="agent-card-role">{agent.role}</div>{expanded === keyFor(agent) && controls(agent)}</article>)}</div>}
      {recentEvents.length > 0 && <section className="agent-timeline" aria-labelledby="agent-timeline-title"><h3 id="agent-timeline-title"><Boxes size={13} />{t("agents.timeline")}</h3><ol>{recentEvents.map((event) => <li key={event.id}><time dateTime={new Date(event.timestamp).toISOString()}>{formatTime(event.timestamp)}</time><span>{event.kind.replace(/[_-]+/g, " ")}</span></li>)}</ol></section>}
    </div>
  </aside>;
};
