import { useCallback, useEffect, useRef, useState } from "react";
import {
  ContextControlState,
  ContextIndexState,
  ContextManifest,
  ContextManifestWire,
  ContextManifestWireItem,
  ContextPreferences,
  ContextSource,
  ContextSourceKind,
  ContextSourceMutation,
  FileContext,
} from "../types";
import { useI18n } from "../i18n";

const EMPTY_INDEX_STATE: ContextIndexState = { status: "idle" };
const EMPTY_CONTROLS: ContextControlState = {
  version: 0,
  pinnedSourceKeys: [],
  pinnedPaths: [],
  excludedSourceKeys: [],
};

interface ContextManifestListState {
  manifestId: string;
  logicalRequestId: string;
  status: ContextManifestWire["status"];
  runId?: string;
  conversationId?: string;
  requestId?: string;
  updatedAt: number;
}

function normalizeKind(value: string): ContextSourceKind {
  const supported: ContextSourceKind[] = [
    "active_file", "selection", "pinned_file", "definition", "reference", "import",
    "test", "diagnostic", "git_history", "memory", "transcript", "repository",
  ];
  return supported.includes(value as ContextSourceKind) ? value as ContextSourceKind : "other";
}

function normalizeItem(item: ContextManifestWireItem): ContextSource {
  const highTrust = ["platform", "authenticated_user", "approved_user_artifact", "workspace_instruction", "local_tool_output"];
  const basis = item.trust === "external_tool_output"
    ? "external" as const
    : item.trust === "model_generated" || item.trust === "generated_file"
      ? "derived" as const
      : item.trust === "authenticated_user" || item.trust === "approved_user_artifact"
        ? "user_buffer" as const
        : "workspace_verified" as const;
  const label = item.source.path
    || item.source.skillName
    || item.source.messageId
    || item.source.toolCallId
    || item.source.indexDocumentId
    || item.kind;
  return {
    id: item.itemId,
    sourceKey: item.itemId,
    kind: normalizeKind(item.kind),
    label,
    path: item.source.path,
    reasonCode: "recorded",
    reasonDetail: item.reason,
    estimatedTokens: item.estimatedTokens,
    tokenCountSource: "estimate",
    decision: item.decision,
    pinned: item.pinned,
    freshness: {
      state: item.freshness === "fresh" ? "fresh" : item.freshness === "unknown" ? "unavailable" : "stale",
      observedAt: item.observedAt,
      contentDigest: item.contentDigest,
    },
    trust: {
      level: highTrust.includes(item.trust) ? "high" : item.trust === "model_generated" ? "low" : "medium",
      basis,
    },
    integrity: item.integrity,
    actions: {
      canPin: Boolean(item.source.path),
      canExclude: Boolean(item.source.path),
      canRefresh: Boolean(item.source.path),
      ...(!item.source.path ? { disabledReasonCode: "path_required" } : {}),
    },
  };
}

function normalizeManifest(manifest: ContextManifestWire): ContextManifest {
  const sources = manifest.items.map(normalizeItem);
  const normalized: ContextManifest = {
    schemaVersion: manifest.schemaVersion,
    id: manifest.manifestId,
    runId: manifest.runId,
    conversationId: manifest.conversationId,
    requestId: manifest.requestId,
    modelCallId: manifest.logicalRequestId,
    purpose: manifest.purpose,
    modelName: manifest.modelName,
    providerId: manifest.providerId,
    attemptCount: manifest.attempts.length,
    revision: manifest.updatedAt,
    createdAt: manifest.createdAt,
    indexRevision: manifest.scope.indexGeneration === undefined ? undefined : String(manifest.scope.indexGeneration),
    status: manifest.status === "completed" ? "ready" : manifest.status === "failed" || manifest.status === "aborted" ? "error" : "building",
    sources,
    totals: {
      includedSources: sources.filter((source) => source.decision === "included").length,
      excludedSources: manifest.excludedCount + manifest.redactedCount + manifest.truncatedCount,
      estimatedTokens: manifest.estimatedPromptTokens,
      reportedTokens: manifest.actualPromptTokens,
    },
    message: manifest.errorCode,
  };
  for (const source of normalized.sources) {
    Object.freeze(source.freshness);
    Object.freeze(source.trust);
    if (source.range) Object.freeze(source.range);
    if (source.actions) Object.freeze(source.actions);
    Object.freeze(source);
  }
  Object.freeze(normalized.sources);
  Object.freeze(normalized.totals);
  return Object.freeze(normalized) as ContextManifest;
}

function auth(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function jsonAuth(token: string): HeadersInit {
  return { ...auth(token), "Content-Type": "application/json" };
}

function upsertManifest(current: ContextManifest[], next: ContextManifest): ContextManifest[] {
  const existing = current.findIndex((item) => item.id === next.id);
  if (existing < 0) return [...current, next].sort((a, b) => a.createdAt - b.createdAt);
  if (current[existing].revision > next.revision) return current;
  const updated = [...current];
  updated[existing] = next;
  return updated;
}

export function useContextManifest(
  token: string,
  workspaceDir: string,
  conversationId: string | null,
  runId?: string,
) {
  const { t } = useI18n();
  /** Persisted model-call evidence. Never apply draft preference overlays here. */
  const [manifests, setManifests] = useState<ContextManifest[]>([]);
  const [draftManifest, setDraftManifest] = useState<ContextManifest | null>(null);
  const [selectedManifestId, setSelectedManifestId] = useState<string | null>(null);
  const [controls, setControls] = useState<ContextControlState>(EMPTY_CONTROLS);
  const [indexState, setIndexState] = useState<ContextIndexState>(EMPTY_INDEX_STATE);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationBySource, setMutationBySource] = useState<Record<string, ContextSourceMutation>>({});
  const requestControllerRef = useRef<AbortController | null>(null);
  const previewControllerRef = useRef<AbortController | null>(null);
  const previewSequenceRef = useRef(0);
  const previewScopeTokenRef = useRef("");
  const lastPreviewContextRef = useRef<FileContext | undefined>(undefined);
  const scopeVersionRef = useRef(0);
  const scopeIdentityRef = useRef("");
  const controlsRef = useRef(controls);
  const preferencesRef = useRef<ContextPreferences | null>(null);
  const conversationRef = useRef(conversationId);
  const runRef = useRef(runId);
  const latestManifestSequenceRef = useRef(0);
  const latestIndexSequenceRef = useRef(0);

  useEffect(() => { controlsRef.current = controls; }, [controls]);
  useEffect(() => { conversationRef.current = conversationId; }, [conversationId]);
  useEffect(() => { runRef.current = runId; }, [runId]);

  const selectedManifest = manifests.find((item) => item.id === selectedManifestId)
    || manifests[manifests.length - 1]
    || null;

  const fetchManifestDetail = useCallback(async (manifestId: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/chat/context-manifests/${encodeURIComponent(manifestId)}`, {
      headers: auth(token),
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || t("context.loadFailed"));
    }
    const payload = await response.json() as { manifest: ContextManifestWire };
    return normalizeManifest(payload.manifest);
  }, [t, token]);

  const acceptManifestEvent = useCallback((payload: unknown) => {
    const event = payload as { manifest?: ContextManifest; manifestId?: string; sequence?: number } & Partial<ContextManifest>;
    const manifest = event.manifest || (event.id && Array.isArray(event.sources) ? event as ContextManifest : undefined);
    if (!manifest?.id && event.manifestId) {
      const scopeVersion = scopeVersionRef.current;
      void fetchManifestDetail(event.manifestId).then((detail) => {
        if (scopeVersion !== scopeVersionRef.current) return;
        if (detail.conversationId && conversationRef.current && detail.conversationId !== conversationRef.current) return;
        if (detail.runId && runRef.current && detail.runId !== runRef.current) return;
        setManifests((current) => upsertManifest(current, detail));
        setSelectedManifestId((current) => current || detail.id);
      }).catch((caught) => {
        if (scopeVersion !== scopeVersionRef.current) return;
        setError(caught instanceof Error ? caught.message : t("context.loadFailed"));
      });
      return;
    }
    if (!manifest?.id) return;
    if (manifest.conversationId && conversationRef.current && manifest.conversationId !== conversationRef.current) return;
    if (manifest.runId && runRef.current && manifest.runId !== runRef.current) return;
    const sequence = Number(event.sequence) || 0;
    if (sequence > 0 && sequence < latestManifestSequenceRef.current) return;
    latestManifestSequenceRef.current = Math.max(latestManifestSequenceRef.current, sequence);
    setManifests((current) => upsertManifest(current, manifest));
    setSelectedManifestId((current) => current || manifest.id);
    setError(null);
  }, [fetchManifestDetail, t]);

  const acceptIndexEvent = useCallback((payload: unknown) => {
    const event = payload as { indexState?: ContextIndexState; sequence?: number; generation?: string; indexedFiles?: number; updatedAt?: number; error?: string; status?: string };
    const raw = event.indexState || event;
    if (!raw?.status) return;
    const next: ContextIndexState = {
      status: raw.status === "rebuilding" ? "indexing" : raw.status === "missing" ? "unavailable" : raw.status as ContextIndexState["status"],
      revision: event.indexState?.revision || (event.generation === undefined ? undefined : String(event.generation)),
      indexedFiles: raw.indexedFiles,
      updatedAt: raw.updatedAt,
      message: event.indexState?.message || event.error,
    };
    const sequence = Number(event.sequence) || 0;
    if (sequence > 0 && sequence < latestIndexSequenceRef.current) return;
    latestIndexSequenceRef.current = Math.max(latestIndexSequenceRef.current, sequence);
    setIndexState(next);
  }, []);

  const refresh = useCallback(async () => {
    const scopeVersion = scopeVersionRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const manifestParams = new URLSearchParams();
      if (runId) manifestParams.set("runId", runId);
      if (conversationId) manifestParams.set("conversationId", conversationId);
      const [manifestResponse, controlResponse, indexResponse] = await Promise.all([
        fetch(`/api/chat/context-manifests?${manifestParams}`, { headers: auth(token), signal: controller.signal }),
        conversationId
          ? fetch(`/api/chat/context-preferences/${encodeURIComponent(conversationId)}`, { headers: auth(token), signal: controller.signal })
          : Promise.resolve(null),
        fetch("/api/chat/context-index/status", { headers: auth(token), signal: controller.signal }),
      ]);
      if (scopeVersion !== scopeVersionRef.current) return;
      if (!manifestResponse.ok && manifestResponse.status !== 404) {
        const body = await manifestResponse.json().catch(() => ({}));
        throw new Error(body.error || t("context.loadFailed"));
      }
      const payload = manifestResponse.ok
        ? await manifestResponse.json() as { manifests?: ContextManifestListState[] }
        : {};
      const summaries = Array.isArray(payload.manifests) ? payload.manifests : [];
      const nextManifests = (await Promise.all(summaries.map((item) => fetchManifestDetail(item.manifestId, controller.signal))))
        .sort((left, right) => left.createdAt - right.createdAt);
      if (scopeVersion !== scopeVersionRef.current) return;
      setManifests(nextManifests);
      setSelectedManifestId((current) => nextManifests.some((item) => item.id === current)
        ? current
        : nextManifests[nextManifests.length - 1]?.id || null);
      if (controlResponse?.ok) {
        const controlPayload = await controlResponse.json() as { preferences: ContextPreferences };
        preferencesRef.current = controlPayload.preferences;
        setControls({
          version: controlPayload.preferences.version,
          pinnedSourceKeys: controlPayload.preferences.pins.map((pin) => pin.id),
          pinnedPaths: controlPayload.preferences.pins.map((pin) => pin.path),
          excludedSourceKeys: controlPayload.preferences.excludes,
        });
      }
      if (indexResponse.ok) {
        const indexPayload = await indexResponse.json() as { index?: { status?: string; generation?: string; revision?: string; indexedFiles?: number; fileCount?: number; updatedAt?: number; lastError?: string } };
        const index = indexPayload.index;
        if (index) setIndexState({
          status: index.status === "rebuilding" ? "indexing" : index.status === "missing" ? "unavailable" : index.status as ContextIndexState["status"],
          revision: index.revision || (index.generation === undefined ? undefined : String(index.generation)),
          indexedFiles: index.indexedFiles ?? index.fileCount,
          updatedAt: index.updatedAt,
          message: index.lastError,
        });
      }
    } catch (caught) {
      if ((caught as DOMException).name === "AbortError") return;
      if (scopeVersion !== scopeVersionRef.current) return;
      setError(caught instanceof Error ? caught.message : t("context.loadFailed"));
    } finally {
      if (scopeVersion === scopeVersionRef.current) setLoading(false);
    }
  }, [conversationId, fetchManifestDetail, runId, t, token]);

  useEffect(() => {
    scopeVersionRef.current += 1;
    scopeIdentityRef.current = `${workspaceDir}\0${conversationId || ""}\0${runId || ""}`;
    latestManifestSequenceRef.current = 0;
    latestIndexSequenceRef.current = 0;
    previewSequenceRef.current += 1;
    previewScopeTokenRef.current = "";
    requestControllerRef.current?.abort();
    previewControllerRef.current?.abort();
    setManifests([]);
    setDraftManifest(null);
    setSelectedManifestId(null);
    setControls(EMPTY_CONTROLS);
    setIndexState(EMPTY_INDEX_STATE);
    setMutationBySource({});
    setError(null);
    void refresh();
    return () => {
      requestControllerRef.current?.abort();
      previewControllerRef.current?.abort();
    };
  }, [conversationId, refresh, runId, workspaceDir]);

  const preview = useCallback(async (context?: FileContext): Promise<ContextManifest | undefined> => {
    lastPreviewContextRef.current = context;
    previewControllerRef.current?.abort();
    const sequence = ++previewSequenceRef.current;
    const scopeVersion = scopeVersionRef.current;
    const scopeIdentity = scopeIdentityRef.current;
    const query = [context?.path, context?.selection].filter(Boolean).join("\n").trim().slice(0, 4_000);
    const requestScopeToken = [
      scopeIdentity,
      context?.path || "",
      context?.selectionRange?.startLine || "",
      context?.selectionRange?.endLine || "",
      context?.selection || "",
    ].join("\0");
    previewScopeTokenRef.current = requestScopeToken;
    if (!query) {
      setDraftManifest(null);
      setPreviewLoading(false);
      setError(null);
      return undefined;
    }
    const controller = new AbortController();
    previewControllerRef.current = controller;
    setPreviewLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/chat/context/preview", {
        method: "POST",
        headers: jsonAuth(token),
        signal: controller.signal,
        body: JSON.stringify({ ...(conversationId ? { conversationId } : {}), query }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || t("context.loadFailed"));
      }
      const payload = await response.json() as {
        candidates?: Array<{
          id: string; path?: string; reason: string; estimatedTokens: number;
          freshness: ContextManifestWireItem["freshness"];
          trust: string;
          decision: ContextManifestWireItem["decision"];
          ruleIds: string[];
        }>;
        preferences?: ContextPreferences;
        index?: { status?: string; generation?: string; indexedFiles?: number; updatedAt?: number; error?: string };
      };
      if (
        controller.signal.aborted
        || sequence !== previewSequenceRef.current
        || scopeVersion !== scopeVersionRef.current
        || scopeIdentity !== scopeIdentityRef.current
        || requestScopeToken !== previewScopeTokenRef.current
      ) return undefined;
      const sources = (payload.candidates || []).map((candidate) => {
        const source = normalizeItem({
          itemId: candidate.id,
          kind: candidate.path === context?.path ? "active_file" : "repository",
          source: { type: candidate.path === context?.path ? "editor_buffer" : "repository_index", path: candidate.path },
          reason: candidate.reason,
          estimatedTokens: candidate.estimatedTokens,
          chars: 0,
          contentDigest: "",
          observedAt: Date.now(),
          freshness: candidate.freshness,
          trust: candidate.trust === "generated" ? "generated_file" : "local_tool_output",
          integrity: "unknown",
          decision: candidate.decision,
          ruleIds: candidate.ruleIds,
          pinned: Boolean(payload.preferences?.pins.some((pin) => pin.id === candidate.id || pin.path === candidate.path)),
        });
        return context?.dirty && candidate.path === context.path
          ? { ...source, freshness: { ...source.freshness, state: "dirty" as const }, trust: { level: "high" as const, basis: "user_buffer" as const } }
          : source;
      });
      for (const pin of payload.preferences?.pins || []) {
        if (sources.some((source) => source.sourceKey === pin.id || source.path === pin.path)) continue;
        sources.push({
          id: pin.id, sourceKey: pin.id, kind: "pinned_file", label: pin.path, path: pin.path,
          reasonCode: "preference_pin", reasonDetail: pin.reason || t("context.reason.preference_pin"), estimatedTokens: 0,
          decision: "included", pinned: true, freshness: { state: "unavailable", observedAt: pin.createdAt },
          trust: { level: "high", basis: "user_buffer" }, integrity: "unknown",
          actions: { canPin: true, canExclude: true, canRefresh: true },
        });
      }
      for (const excludedPath of payload.preferences?.excludes || []) {
        if (sources.some((source) => source.path === excludedPath && source.decision === "excluded")) continue;
        sources.push({
          id: `exclude:${excludedPath}`, sourceKey: `exclude:${excludedPath}`, kind: "repository",
          label: excludedPath, path: excludedPath, reasonCode: "preference_exclude",
          reasonDetail: t("context.reason.preference_exclude"), estimatedTokens: 0, decision: "excluded", pinned: false,
          freshness: { state: "unavailable", observedAt: payload.preferences?.updatedAt },
          trust: { level: "high", basis: "user_buffer" }, integrity: "unknown",
          actions: { canPin: false, canExclude: true, canRefresh: false },
        });
      }
      const manifest: ContextManifest = {
        schemaVersion: 1,
        id: `preview:${conversationId || "new"}:${sequence}`,
        conversationId: conversationId || undefined,
        modelCallId: t("context.previewCall"),
        revision: payload.preferences?.version || sequence,
        createdAt: Date.now(),
        status: "ready",
        sources,
        totals: {
          includedSources: sources.filter((source) => source.decision === "included").length,
          excludedSources: sources.filter((source) => source.decision !== "included").length,
          estimatedTokens: sources.filter((source) => source.decision === "included").reduce((sum, source) => sum + source.estimatedTokens, 0),
        },
      };
      setDraftManifest(manifest);
      if (payload.preferences) {
        preferencesRef.current = payload.preferences;
        setControls({
          version: payload.preferences.version,
          pinnedSourceKeys: payload.preferences.pins.map((pin) => pin.id),
          pinnedPaths: payload.preferences.pins.map((pin) => pin.path),
          excludedSourceKeys: payload.preferences.excludes,
        });
      }
      return manifest;
    } catch (caught) {
      if ((caught as DOMException).name === "AbortError") return undefined;
      if (
        sequence === previewSequenceRef.current
        && scopeVersion === scopeVersionRef.current
        && scopeIdentity === scopeIdentityRef.current
        && requestScopeToken === previewScopeTokenRef.current
      ) setError(caught instanceof Error ? caught.message : t("context.loadFailed"));
      return undefined;
    } finally {
      if (
        sequence === previewSequenceRef.current
        && scopeIdentity === scopeIdentityRef.current
        && requestScopeToken === previewScopeTokenRef.current
      ) setPreviewLoading(false);
    }
  }, [conversationId, t, token]);

  const updateSource = useCallback(async (sourceKey: string, action: Exclude<ContextSourceMutation, "refresh">) => {
    if (!conversationId || mutationBySource[sourceKey]) return;
    const mutationScopeVersion = scopeVersionRef.current;
    const mutationScopeIdentity = scopeIdentityRef.current;
    const previousControls = controlsRef.current;
    const previousPreferences = preferencesRef.current;
    const source = [draftManifest, ...manifests]
      .filter((manifest): manifest is ContextManifest => Boolean(manifest))
      .flatMap((manifest) => manifest.sources)
      .find((item) => item.sourceKey === sourceKey);
    if (!source?.path || !previousPreferences) {
      setError(t("context.pathRequired"));
      return;
    }
    const pins = action === "pin"
      ? [...previousPreferences.pins.filter((pin) => pin.id !== sourceKey), {
          id: sourceKey,
          path: source.path,
          reason: source.reasonDetail,
          createdAt: Date.now(),
        }]
      : action === "unpin"
        ? previousPreferences.pins.filter((pin) => pin.id !== sourceKey)
        : previousPreferences.pins;
    const excludes = action === "exclude"
      ? [...new Set([...previousPreferences.excludes, source.path])]
      : action === "restore"
        ? previousPreferences.excludes.filter((path) => path !== source.path)
        : previousPreferences.excludes;
    setMutationBySource((current) => ({ ...current, [sourceKey]: action }));
    setError(null);
    try {
      const response = await fetch(`/api/chat/context-preferences/${encodeURIComponent(conversationId)}`, {
        method: "PUT",
        headers: jsonAuth(token),
        body: JSON.stringify({ expectedVersion: previousControls.version, pins, excludes }),
      });
      const payload = await response.json().catch(() => ({})) as { preferences?: ContextPreferences; error?: string };
      if (mutationScopeVersion !== scopeVersionRef.current || mutationScopeIdentity !== scopeIdentityRef.current) return;
      if (response.status === 409) {
        if (payload.preferences) {
          preferencesRef.current = payload.preferences;
          setControls({
            version: payload.preferences.version,
            pinnedSourceKeys: payload.preferences.pins.map((pin) => pin.id),
            pinnedPaths: payload.preferences.pins.map((pin) => pin.path),
            excludedSourceKeys: payload.preferences.excludes,
          });
        }
        await preview(lastPreviewContextRef.current);
        setError(t("context.versionConflict"));
        return;
      }
      if (!response.ok) throw new Error(payload.error || t("context.updateFailed"));
      if (payload.preferences) {
        preferencesRef.current = payload.preferences;
        setControls({
          version: payload.preferences.version,
          pinnedSourceKeys: payload.preferences.pins.map((pin) => pin.id),
          pinnedPaths: payload.preferences.pins.map((pin) => pin.path),
          excludedSourceKeys: payload.preferences.excludes,
        });
      }
      await preview(lastPreviewContextRef.current);
    } catch (caught) {
      if (mutationScopeVersion !== scopeVersionRef.current || mutationScopeIdentity !== scopeIdentityRef.current) return;
      if (controlsRef.current.version === previousControls.version) {
        preferencesRef.current = previousPreferences;
        setControls(previousControls);
      }
      setError(caught instanceof Error ? caught.message : t("context.updateFailed"));
    } finally {
      if (mutationScopeVersion === scopeVersionRef.current && mutationScopeIdentity === scopeIdentityRef.current) {
        setMutationBySource((current) => {
          const next = { ...current };
          delete next[sourceKey];
          return next;
        });
      }
    }
  }, [conversationId, draftManifest, manifests, mutationBySource, preview, t, token]);

  const refreshSources = useCallback(async (sourceKeys?: string[]) => {
    const keys = sourceKeys || [];
    const paths = keys
      .map((key) => [draftManifest, ...manifests]
        .filter((manifest): manifest is ContextManifest => Boolean(manifest))
        .flatMap((manifest) => manifest.sources)
        .find((source) => source.sourceKey === key)?.path)
      .filter((path): path is string => Boolean(path));
    setMutationBySource((current) => ({
      ...current,
      ...Object.fromEntries(keys.map((key) => [key, "refresh" as const])),
    }));
    setLoading(keys.length === 0);
    setError(null);
    try {
      const response = await fetch("/api/chat/context-index/refresh", {
        method: "POST",
        headers: jsonAuth(token),
        body: JSON.stringify(paths.length > 0 ? { paths } : {}),
      });
      const payload = await response.json().catch(() => ({})) as { index?: { status?: string; generation?: string; indexedFiles?: number; updatedAt?: number; error?: string }; error?: string };
      if (!response.ok) throw new Error(payload.error || t("context.refreshFailed"));
      if (payload.index) setIndexState({
        status: payload.index.status === "rebuilding" ? "indexing" : payload.index.status === "missing" ? "unavailable" : payload.index.status as ContextIndexState["status"],
        revision: payload.index.generation === undefined ? undefined : String(payload.index.generation),
        indexedFiles: payload.index.indexedFiles,
        updatedAt: payload.index.updatedAt,
        message: payload.index.error,
      });
      await Promise.all([refresh(), preview(lastPreviewContextRef.current)]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("context.refreshFailed"));
    } finally {
      setLoading(false);
      setMutationBySource((current) => {
        const next = { ...current };
        keys.forEach((key) => delete next[key]);
        return next;
      });
    }
  }, [draftManifest, manifests, preview, refresh, t, token]);

  const rebuildIndex = useCallback(async () => {
    setIndexState((current) => ({ ...current, status: "indexing" }));
    const response = await fetch("/api/chat/context-index/rebuild", {
      method: "POST",
      headers: jsonAuth(token),
      body: JSON.stringify({}),
    });
    const payload = await response.json().catch(() => ({})) as { index?: { status?: string; generation?: string; indexedFiles?: number; updatedAt?: number; error?: string }; error?: string };
    if (!response.ok) {
      setIndexState((current) => ({ ...current, status: "error", message: payload.error }));
      throw new Error(payload.error || t("context.rebuildFailed"));
    }
    if (payload.index) setIndexState({
      status: payload.index.status === "rebuilding" ? "indexing" : payload.index.status === "missing" ? "unavailable" : payload.index.status as ContextIndexState["status"],
      revision: payload.index.generation === undefined ? undefined : String(payload.index.generation),
      indexedFiles: payload.index.indexedFiles,
      updatedAt: payload.index.updatedAt,
      message: payload.index.error,
    });
    await preview(lastPreviewContextRef.current);
  }, [preview, t, token]);

  return {
    manifests,
    draftManifest,
    draftManifests: draftManifest ? [draftManifest] : [],
    selectedManifest,
    selectedManifestId,
    setSelectedManifestId,
    controls,
    indexState,
    loading: loading || previewLoading,
    historyLoading: loading,
    previewLoading,
    previewAvailable: true,
    preferenceMutationsAvailable: Boolean(conversationId),
    error,
    mutationBySource,
    refresh,
    preview,
    retryPreview: () => preview(lastPreviewContextRef.current),
    refreshSources,
    rebuildIndex,
    pinSource: (sourceKey: string) => updateSource(sourceKey, "pin"),
    unpinSource: (sourceKey: string) => updateSource(sourceKey, "unpin"),
    excludeSource: (sourceKey: string) => updateSource(sourceKey, "exclude"),
    restoreSource: (sourceKey: string) => updateSource(sourceKey, "restore"),
    acceptManifestEvent,
    acceptIndexEvent,
  };
}

export type ContextManifestController = ReturnType<typeof useContextManifest>;
