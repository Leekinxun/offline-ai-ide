import { useCallback, useEffect, useRef, useState } from "react";
import type { OfflineBundleExport, OfflineBundleVerification } from "../types";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const terminal = new Set<OfflineBundleExport["status"]>(["ready", "failed", "interrupted"]);

function filename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") || "";
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  try { return decodeURIComponent(utf8 || plain || fallback); } catch { return fallback; }
}

async function saveResponse(response: Response, fallback: string): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Download failed: ${response.status}`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename(response, fallback);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function saveReviewArtifact(response: Response, fallback: string, format: "crewforge" | "sarif"): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Review artifact download failed: ${response.status}`);
  }
  const contentType = response.headers.get("Content-Type") || "";
  const expected = format === "sarif" ? /application\/sarif\+json/i : /application\/vnd\.crewforge\.review\.v1\+json/i;
  if (!expected.test(contentType)) throw new Error(`Review artifact returned an invalid content type: ${contentType || "missing"}`);
  const payload = await response.json() as { version?: string; runs?: unknown[]; schemaVersion?: number };
  if (format === "sarif" && (payload.version !== "2.1.0" || !Array.isArray(payload.runs))) throw new Error("Review artifact is not a valid SARIF 2.1.0 document");
  if (format === "crewforge" && payload.schemaVersion !== 1) throw new Error("Review artifact schema is not CrewForge review v1");
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename(response, fallback);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function useOfflineBundles(token: string, workspaceDir: string) {
  const [exportsById, setExportsById] = useState<Record<string, OfflineBundleExport>>({});
  const [verification, setVerification] = useState<OfflineBundleVerification | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopeRef = useRef(workspaceDir);
  const pollingControllersRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    scopeRef.current = workspaceDir;
    pollingControllersRef.current.forEach((controller) => controller.abort());
    pollingControllersRef.current.clear();
    setExportsById({});
    setVerification(null);
    setError(null);
  }, [workspaceDir]);

  useEffect(() => () => {
    pollingControllersRef.current.forEach((controller) => controller.abort());
    pollingControllersRef.current.clear();
  }, []);

  const pollExport = useCallback(async (exportId: string) => {
    pollingControllersRef.current.get(exportId)?.abort();
    const controller = new AbortController();
    pollingControllersRef.current.set(exportId, controller);
    const requestScope = workspaceDir;
    try {
      const response = await fetch(`/api/checkpoints/bundle-exports/${encodeURIComponent(exportId)}`, {
        headers: auth(token),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "Bundle export status failed");
      }
      const body = await response.json() as OfflineBundleExport | { export: OfflineBundleExport };
      if (controller.signal.aborted || requestScope !== scopeRef.current) return null;
      const next = "export" in body ? body.export : body;
      setExportsById((current) => ({ ...current, [next.exportId]: next }));
      return next;
    } finally {
      if (pollingControllersRef.current.get(exportId) === controller) pollingControllersRef.current.delete(exportId);
    }
  }, [token, workspaceDir]);

  const refreshExports = useCallback(async () => {
    const response = await fetch("/api/checkpoints/bundle-exports", { headers: auth(token) });
    if (!response.ok) throw new Error("Bundle export list failed");
    const body = await response.json() as { exports?: OfflineBundleExport[] };
    setExportsById(Object.fromEntries((body.exports || []).map((entry) => [entry.exportId, entry])));
  }, [token]);

  useEffect(() => { void refreshExports().catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Bundle export list failed")); }, [refreshExports, workspaceDir]);

  useEffect(() => {
    const pending = Object.values(exportsById).filter((entry) => !terminal.has(entry.status));
    if (!pending.length) return;
    const timer = window.setInterval(() => {
      pending.forEach((entry) => {
        void pollExport(entry.exportId).catch((nextError) => {
          if (nextError instanceof DOMException && nextError.name === "AbortError") return;
          setError(nextError instanceof Error ? nextError.message : "Bundle export status failed");
        });
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [exportsById, pollExport]);

  const exportReviewArtifact = useCallback(async (changeSetId: string, revision: string, format: "crewforge" | "sarif") => {
    setBusyId(`artifact:${changeSetId}:${format}`);
    setError(null);
    try {
      const query = new URLSearchParams({ revision, format });
      const response = await fetch(`/api/checkpoints/change-sets/${encodeURIComponent(changeSetId)}/review-artifact?${query}`, { headers: auth(token) });
      await saveReviewArtifact(response, `crewforge-review-${changeSetId}.${format === "sarif" ? "sarif.json" : "json"}`, format);
    } catch (nextError) {
      const normalized = nextError instanceof Error ? nextError : new Error("Review artifact export failed");
      setError(normalized.message);
      throw normalized;
    } finally {
      setBusyId(null);
    }
  }, [token]);

  const createExport = useCallback(async (changeSetId: string, revision: string, options: { includeTrace: boolean; includeTestOutput: boolean; requireSignature: boolean }) => {
    setBusyId(`bundle:${changeSetId}`);
    setError(null);
    try {
      const response = await fetch(`/api/checkpoints/change-sets/${encodeURIComponent(changeSetId)}/bundle-exports`, {
        method: "POST",
        headers: { ...auth(token), "Content-Type": "application/json" },
        body: JSON.stringify({ revision, ...options }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "Bundle export could not be started");
      }
      const body = await response.json() as OfflineBundleExport | { export?: OfflineBundleExport; exportId?: string; status?: OfflineBundleExport["status"] };
      const next = "exportId" in body && "changeSetId" in body
        ? body as OfflineBundleExport
        : "export" in body && body.export
          ? body.export
          : { exportId: body.exportId || "", changeSetId, revision, status: body.status || "queued" };
      if (!next.exportId) throw new Error("Bundle export did not return an id");
      setExportsById((current) => ({ ...current, [next.exportId]: next }));
      return next;
    } catch (nextError) {
      const normalized = nextError instanceof Error ? nextError : new Error("Bundle export failed");
      setError(normalized.message);
      throw normalized;
    } finally {
      setBusyId(null);
    }
  }, [token]);

  const download = useCallback(async (entry: OfflineBundleExport) => {
    if (entry.status !== "ready") throw new Error("Bundle is not ready");
    setBusyId(`download:${entry.exportId}`);
    setError(null);
    try {
      const response = await fetch(`/api/checkpoints/bundle-exports/${encodeURIComponent(entry.exportId)}/download`, { headers: auth(token) });
      await saveResponse(response, `crewforge-bundle-${entry.changeSetId}-${entry.revision.slice(0, 12)}.zip`);
    } catch (nextError) {
      const normalized = nextError instanceof Error ? nextError : new Error("Bundle download failed");
      setError(normalized.message);
      throw normalized;
    } finally {
      setBusyId(null);
    }
  }, [token]);

  const verify = useCallback(async (file: File) => {
    setBusyId("verify");
    setError(null);
    setVerification(null);
    try {
      const bundleBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("Bundle read failed"));
        reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
        reader.readAsDataURL(file);
      });
      const response = await fetch("/api/checkpoints/bundles/verify", { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify({ bundleBase64 }) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "Bundle verification failed");
      }
      const body = await response.json() as OfflineBundleVerification | { verification: OfflineBundleVerification };
      const next = "verification" in body ? body.verification : body;
      setVerification(next);
      return next;
    } catch (nextError) {
      const normalized = nextError instanceof Error ? nextError : new Error("Bundle verification failed");
      setError(normalized.message);
      throw normalized;
    } finally {
      setBusyId(null);
    }
  }, [token]);

  return { exports: Object.values(exportsById), verification, busyId, error, refreshExports, exportReviewArtifact, createExport, pollExport, download, verify, clearError: () => setError(null) };
}
