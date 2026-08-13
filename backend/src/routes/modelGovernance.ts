import { Router } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { getLlmSettings } from "../config.js";
import { ModelBudgetGovernor, type BudgetScope, type BudgetScopeKind } from "../agent/modelBudget.js";
import { getModelCapabilities } from "../agent/modelCapabilities.js";
import { getProviderAdapter, listProviderAdapters } from "../agent/providerAdapter.js";
import { modelSuitability, type ModelRole } from "../agent/providerConformance.js";
import { canSessionManageAgentBudget } from "../team/agentSnapshot.js";

export const modelGovernanceRouter = Router();
const ROLES: ModelRole[] = ["ask", "plan", "code", "review", "explore", "verifier"];
const KINDS: BudgetScopeKind[] = ["workspace", "team", "task", "agent"];
function session(req: unknown): UserSession { return (req as any).userSession as UserSession; }
function governor(req: unknown): ModelBudgetGovernor { return new ModelBudgetGovernor(session(req).workspaceDir); }
function scope(kind: unknown, id: unknown): BudgetScope { if (!KINDS.includes(kind as BudgetScopeKind) || typeof id !== "string" || !id.trim()) throw new Error("Invalid budget scope"); return { kind: kind as BudgetScopeKind, id: id.trim() }; }
function expectedVersion(req: any): number | null { const raw = req.body?.expectedVersion ?? req.get?.("If-Match"); const normalized = typeof raw === "string" ? raw.replace(/^W\//, "").replace(/^"|"$/g, "") : raw; const parsed = typeof normalized === "number" ? normalized : typeof normalized === "string" && /^\d+$/.test(normalized) ? Number(normalized) : NaN; return Number.isSafeInteger(parsed) ? parsed : null; }
function canManage(req: unknown): boolean { const current = session(req); return current.isAdmin === true || canSessionManageAgentBudget(current as any); }

modelGovernanceRouter.get("/capabilities", async (req, res) => {
  try {
    const llm = getLlmSettings(); const providerId = typeof req.query.providerId === "string" ? req.query.providerId : "openai-compatible"; const adapter = getProviderAdapter(providerId);
    const capabilities = await getModelCapabilities({ apiUrl: llm.vllmApiUrl, apiKey: llm.vllmApiKey, modelName: typeof req.query.model === "string" && req.query.model.trim() ? req.query.model.trim() : llm.modelName, fallbackMaxOutputTokens: llm.maxTokens, declaredSupports: adapter.declaredSupports }, req.query.refresh === "1");
    res.json({ providerId, capabilities, suitability: Object.fromEntries(ROLES.map((role) => [role, modelSuitability(role, capabilities)])), adapters: listProviderAdapters() });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "Capability discovery failed" }); }
});

modelGovernanceRouter.get("/budgets", (req, res) => { try { res.json({ budgets: governor(req).list() }); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Budget read failed" }); } });
modelGovernanceRouter.put("/budgets/:kind/:id", (req, res) => {
  if (!canManage(req)) return res.status(403).json({ error: "Only workspace/team owners or admins may update budgets" }); const version = expectedVersion(req); if (version === null) return res.status(428).json({ error: "expectedVersion or If-Match required" });
  try { res.json({ budget: governor(req).update(scope(req.params.kind, req.params.id), req.body?.policy || {}, version) }); } catch (error) { const message = error instanceof Error ? error.message : "Budget update failed"; res.status(/version conflict/i.test(message) ? 409 : 400).json({ error: message }); }
});
modelGovernanceRouter.post("/budgets/preflight", (req, res) => {
  try { const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.map((item: any) => scope(item?.kind, item?.id)) : []; const tokens = req.body?.estimatedTokens; const costUsd = req.body?.estimatedCostUsd; res.json({ preflight: governor(req).preflight(scopes, { tokens, costUsd }) }); } catch (error: any) { res.status(error?.code === "budget_exhausted" ? 409 : 400).json({ code: error?.code || "INVALID_REQUEST", recoverable: error?.recoverable === true, error: error instanceof Error ? error.message : "Budget preflight failed" }); }
});
