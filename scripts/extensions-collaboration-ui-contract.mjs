import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const sources = {
  app: read("frontend/src/App.tsx"), team: read("frontend/src/components/TeamPanel.tsx"), agents: read("frontend/src/components/AgentBoard.tsx"), editor: read("frontend/src/components/Editor.tsx"), contextStrip: read("frontend/src/components/ContextStrip.tsx"),
  plugins: read("frontend/src/components/PluginManagerPanel.tsx"), settings: read("frontend/src/components/SettingsModal.tsx"),
  runDetails: read("frontend/src/components/RunDetailsPanel.tsx"), editorAssistant: read("frontend/src/components/EditorAssistantPanel.tsx"),
  changeDiff: read("frontend/src/components/ChangeDiffDialog.tsx"), teamHook: read("frontend/src/hooks/useTeam.ts"),
  pluginHook: read("frontend/src/hooks/usePlugins.ts"), policyHook: read("frontend/src/hooks/useExtensionPolicy.ts"),
  governanceHook: read("frontend/src/hooks/useModelGovernance.ts"), governance: read("frontend/src/components/ModelGovernancePanel.tsx"),
  messages: read("frontend/src/i18n/messages.ts"), css: read("frontend/src/App.css"), backendIndex: read("backend/src/index.ts"), teamRoute: read("backend/src/routes/team.ts"), policyRoute: read("backend/src/routes/extensionsPolicy.ts"),
};
const requireText = (source, text, description) => { if (!source.includes(text)) throw new Error(`Extensions/collaboration UI contract failed: ${description} (missing ${JSON.stringify(text)})`); };
const forbidText = (source, text, description) => { if (source.includes(text)) throw new Error(`Extensions/collaboration UI contract failed: ${description} (unexpected ${JSON.stringify(text)})`); };

requireText(sources.backendIndex, 'app.use("/api/extension-policy"', "extension policy route is mounted");
requireText(sources.backendIndex, 'app.use("/api/model-governance"', "model governance route is mounted");
requireText(sources.teamRoute, 'teamRouter.get("/collaboration"', "collaboration snapshot route exists");
for (const route of ["comments", "review-requests", "merge-previews", "merge-decisions"]) requireText(sources.teamHook, `\"${route}\"`, `collaboration UI uses ${route}`);
requireText(sources.teamHook, "expectedVersion: collaboration.version", "collaboration mutations use CAS");
requireText(sources.teamHook, "refreshAbortRef.current?.abort()", "team state is request-cancelled and scope safe");
requireText(sources.teamHook, 'type: "buffer_register"', "unsaved buffers are published over the team socket");
requireText(sources.app, "sha256Text(activeFile.content)", "unsaved-buffer presence uses actual content digests");
requireText(sources.editor, "collaborationDecorationIdsRef", "editor renders durable collaboration anchors");
requireText(sources.contextStrip, "collaboration.contextSummary", "context strip exposes collaboration state");
requireText(sources.team, "collaboration-owner-badge", "human/agent ownership is visible");
requireText(sources.team, "item.mentions", "mentions are visible");
requireText(sources.team, "item.evidenceLinks", "evidence links are visible");
requireText(sources.team, "threeWayPreview", "3-way conflicts have an explicit preview");
requireText(sources.team, "preview.allowedActions", "merge choices come from server-owned allowed actions");
requireText(sources.team, 'latestDecision.status !== "resolved" && latestDecision.choice !== "apply-agent"', "pending and stale human/manual decisions remain visibly unresolved");
requireText(sources.team, 'latestDecision.status === "resolved" && latestDecision.choice === "apply-agent"', "only exact apply-agent decisions are shown as resolved");
requireText(sources.team, "pendingAction?.requiresSave", "pending human/manual decisions display server-owned save requirements");
requireText(sources.team, "pendingAction?.requiresNewRevision", "pending human/manual decisions display server-owned new-revision requirements");
requireText(sources.team, 'action.choice === "manual" ? preview.humanDigest', "manual pending decisions bind the exact server-preview human digest");
requireText(sources.team, 'decision.status !== "resolved"', "only unresolved prior decisions may be superseded by a new revision");
requireText(sources.team, "collaboration.originalRevisionBlocked", "pending decisions explicitly keep the original change set blocked");
requireText(sources.team, "collaboration.refreshAfterRevision", "UI refreshes after save and new revision instead of releasing stale change sets");
requireText(sources.team, "latestDecision.supersedesDecisionId", "resolved human/manual UI is tied to a superseding new revision");
requireText(sources.team, "collaboration.newRevisionResolved", "new-revision resolution keeps the superseded original visibly blocked");
requireText(sources.team, "collaboration.finalizeNewRevision", "superseding resolution is labeled as a new-revision finalization");
requireText(sources.policyHook, 'const response = await fetch("/api/extension-policy/explain"', "effective permission explanations come from the server");
requireText(sources.policyHook, "pluginId: binding.pluginId", "explain submits a server-known signed plugin binding");
requireText(sources.policyHook, "profileId: binding.profileId", "explain submits a server-known profile binding when present");
requireText(sources.policyHook, "hookId: binding.hookId", "explain submits a server-known hook binding when present");
forbidText(sources.policyHook, "layers, sandboxLayers", "clients cannot self-report permission or sandbox layers");
requireText(sources.plugins, "extensionPolicy.policy.plugins", "explain bindings come from the server policy registry response");
requireText(sources.plugins, "hookId: hook.id", "hook explanation uses the exact server hook id");
requireText(sources.plugins, "explanation.layers", "permission decision layers are rendered");
requireText(sources.plugins, "explanation.effectiveSandbox", "server-evaluated effective sandbox is rendered");
requireText(sources.plugins, "hook.transport.kind", "hook transport is rendered");
requireText(sources.plugins, "hook.failureMode", "hook failure policy is rendered");
requireText(sources.plugins, 'teamRole === null || teamRole === "owner" || teamRole === "admin"', "workspace policy editor is hidden from team members and viewers");
requireText(sources.policyRoute, 'role !== "owner" && role !== "admin"', "workspace policy writes remain server-forbidden for team members and viewers");
requireText(sources.policyHook, '"If-Match": String(policy.workspace.version)', "workspace policy updates use CAS");
requireText(sources.pluginHook, "refreshControllerRef.current?.abort()", "plugin registry requests are cancelled");
requireText(sources.governanceHook, 'const [capabilityResponse, budgetResponse] = await Promise.all', "capabilities and budgets use real governance APIs");
requireText(sources.governanceHook, '"If-Match": String(entry.version)', "budget updates use CAS");
requireText(sources.governance, "capability.suitability", "model suitability is visible");
requireText(sources.governance, "governance.fallbackGuard", "server-owned fallback safety is visible without client inference");
requireText(sources.governance, "provider_reported", "reported usage is distinguished from estimated usage");
requireText(sources.governance, "governance.preflight", "dispatch budget warnings use server preflight");
requireText(sources.agents, "agent.canManageBudget === true", "server-owned agent authorization hides write controls");
requireText(sources.team, 'currentRole !== "viewer"', "viewer team writes are hidden");
requireText(sources.settings, "<ActionConfirmDialog", "sensitive settings writes use the shared accessible confirmation dialog");
requireText(sources.settings, "returnFocusRef", "settings dialog restores focus");
requireText(sources.changeDiff, "copyError", "clipboard failure is visible");
requireText(sources.runDetails, 'qualityGate?.status === "blocked"', "quality-hook blocked completion overrides nominal completion evidence");
requireText(sources.runDetails, 'evidenceOutcome === "completed" ? "" : "warning"', "quality-hook blocked completion is rendered as non-success evidence");
requireText(sources.runDetails, 'event.decision === "blocked"', "blocked quality-gate trace events are visibly failed");
requireText(sources.editorAssistant, 'evidenceOutcome === "completed" ? "" : "warning"', "editor assistant never presents blocked completion evidence as success");
requireText(sources.css, "@media (max-width: 780px)", "G006 UI has the required responsive breakpoint");
requireText(sources.css, "min-height: 40px", "G006 interactive controls meet the touch target contract");
for (const source of [sources.app, sources.team, sources.agents, sources.editor, sources.contextStrip, sources.plugins, sources.settings, sources.changeDiff, sources.teamHook, sources.pluginHook, sources.policyHook, sources.governanceHook]) {
  forbidText(source, "window.confirm", "assigned collaboration surfaces use no native confirm");
  forbidText(source, ".catch(() => undefined)", "assigned collaboration surfaces use no silent catch");
}
for (const key of ["collaboration.threeWayPreview", "plugin.effectivePermissions", "governance.reportedUsage", "governance.estimatedUsage"]) {
  const count = sources.messages.split(`\"${key}\"`).length - 1;
  if (count !== 2) throw new Error(`Extensions/collaboration UI contract failed: ${key} must exist in English and Chinese exactly once each`);
}
console.log("CrewForge extensions/collaboration UI contract passed.");
