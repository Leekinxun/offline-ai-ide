import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelBudgetEntry, ModelCapabilities, ModelRole, ModelSuitability } from "../types";

interface CapabilityPayload { providerId: string; capabilities: ModelCapabilities; suitability: Record<ModelRole, ModelSuitability>; adapters: string[]; }
async function parse<T>(response: Response): Promise<T> { const payload = await response.json().catch(() => ({})) as T & { error?: string }; if (!response.ok) throw new Error(payload.error || `Model governance request failed (${response.status})`); return payload; }

export function useModelGovernance(token: string, visible: boolean, modelName: string) {
  const [capability, setCapability] = useState<CapabilityPayload | null>(null);
  const [budgets, setBudgets] = useState<ModelBudgetEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const refresh = useCallback(async (force = false) => {
    const generation = ++generationRef.current; controllerRef.current?.abort(); const controller = new AbortController(); controllerRef.current = controller; setLoading(true); setError(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [capabilityResponse, budgetResponse] = await Promise.all([
        fetch(`/api/model-governance/capabilities?providerId=openai-compatible${modelName ? `&model=${encodeURIComponent(modelName)}` : ""}${force ? "&refresh=1" : ""}`, { headers, signal: controller.signal, cache: "no-store" }),
        fetch("/api/model-governance/budgets", { headers, signal: controller.signal, cache: "no-store" }),
      ]);
      const [nextCapability, budgetPayload] = await Promise.all([parse<CapabilityPayload>(capabilityResponse), parse<{ budgets: ModelBudgetEntry[] }>(budgetResponse)]);
      if (generation === generationRef.current) { setCapability(nextCapability); setBudgets(Array.isArray(budgetPayload.budgets) ? budgetPayload.budgets : []); }
    } catch (reason) { if (!controller.signal.aborted && generation === generationRef.current) setError(reason instanceof Error ? reason.message : "Model governance unavailable"); }
    finally { if (generation === generationRef.current) setLoading(false); }
  }, [modelName, token]);
  useEffect(() => { if (visible) void refresh(); return () => controllerRef.current?.abort(); }, [refresh, visible]);
  const updateBudget = useCallback(async (entry: ModelBudgetEntry, policy: ModelBudgetEntry["policy"]) => {
    const response = await fetch(`/api/model-governance/budgets/${entry.scope.kind}/${encodeURIComponent(entry.scope.id)}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": String(entry.version) }, body: JSON.stringify({ policy, expectedVersion: entry.version }) });
    try { const payload = await parse<{ budget: ModelBudgetEntry }>(response); setBudgets((current) => [...current.filter((item) => item.scope.kind !== entry.scope.kind || item.scope.id !== entry.scope.id), payload.budget]); return payload.budget; }
    catch (reason) { if (response.status === 409) await refresh(); throw reason; }
  }, [refresh, token]);
  const preflight = useCallback(async (estimatedTokens: number, estimatedCostUsd: number) => {
    const response = await fetch("/api/model-governance/budgets/preflight", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ scopes: budgets.map((entry) => entry.scope), estimatedTokens, estimatedCostUsd }) });
    return parse<{ preflight: { versions: Record<string, number>; warnings: ModelBudgetEntry[] } }>(response);
  }, [budgets, token]);
  return { capability, budgets, error, loading, refresh, updateBudget, preflight };
}
