import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminExtensionPolicy, ExtensionPolicyBinding, PermissionExplanation, PermissionLayer, RegisteredExtensionPolicyPlugin, SandboxGrant, WorkspaceExtensionPolicy } from "../types";

interface PolicyResponse { admin: AdminExtensionPolicy; workspace: WorkspaceExtensionPolicy; plugins: RegisteredExtensionPolicyPlugin[]; }

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Extension policy request failed (${response.status})`);
  return payload;
}

export function useExtensionPolicy(token: string, visible: boolean) {
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/extension-policy", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal });
      const next = await responseJson<PolicyResponse>(response);
      if (generation === generationRef.current) setPolicy(next);
    } catch (reason) {
      if (!controller.signal.aborted && generation === generationRef.current) setError(reason instanceof Error ? reason.message : "Extension policy unavailable");
    } finally { if (generation === generationRef.current) setLoading(false); }
  }, [token]);
  useEffect(() => { if (visible) void refresh(); return () => controllerRef.current?.abort(); }, [refresh, visible]);
  const updateWorkspace = useCallback(async (permissions: PermissionLayer, sandbox: SandboxGrant) => {
    if (!policy) throw new Error("Extension policy unavailable");
    const response = await fetch("/api/extension-policy/workspace", { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": String(policy.workspace.version) }, body: JSON.stringify({ permissions, sandbox, expectedVersion: policy.workspace.version }) });
    try { const payload = await responseJson<{ workspace: WorkspaceExtensionPolicy }>(response); setPolicy((current) => current ? { ...current, workspace: payload.workspace } : current); return payload.workspace; }
    catch (reason) { if (response.status === 409) await refresh(); throw reason; }
  }, [policy, refresh, token]);
  const updateAdmin = useCallback(async (permissions: PermissionLayer, sandbox: SandboxGrant) => {
    if (!policy) throw new Error("Extension policy unavailable");
    const response = await fetch("/api/extension-policy/admin", { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": String(policy.admin.version) }, body: JSON.stringify({ permissions, sandbox, expectedVersion: policy.admin.version }) });
    try { const payload = await responseJson<{ admin: AdminExtensionPolicy }>(response); setPolicy((current) => current ? { ...current, admin: payload.admin } : current); return payload.admin; }
    catch (reason) { if (response.status === 409) await refresh(); throw reason; }
  }, [policy, refresh, token]);
  const explain = useCallback(async (permission: string, binding: ExtensionPolicyBinding) => {
    const response = await fetch("/api/extension-policy/explain", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ permission, pluginId: binding.pluginId, ...(binding.profileId ? { profileId: binding.profileId } : {}), ...(binding.skillIds?.length ? { skillIds: binding.skillIds } : {}), ...(binding.hookId ? { hookId: binding.hookId } : {}) }) });
    const payload = await responseJson<{ explanation: PermissionExplanation }>(response);
    return payload.explanation;
  }, [token]);
  return { policy, loading, error, refresh, updateWorkspace, updateAdmin, explain };
}
