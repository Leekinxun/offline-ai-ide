import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, MousePointer2, Play, RefreshCw, Square, X } from "lucide-react";
import { useI18n } from "../i18n";
import { ActionConfirmDialog } from "./ActionConfirmDialog";
import "./PreviewPanel.css";

interface PreviewTarget { id: string; label: string; kind: "vite" | "static"; taskId?: string; }
interface PreviewSession { id: string; targetId: string; label: string; kind: string; status: string; error?: string; }
interface PreviewEvent { kind: "error" | "console" | "selection"; message: string; selector?: string; sourceCandidates?: Array<{ path: string; line?: number; column?: number }>; }

export function PreviewPanel({ token, workspaceDir, readOnly, onClose, onFeedback, onOpenSource }: {
  token: string; workspaceDir: string; readOnly: boolean; onClose: () => void;
  onFeedback: (text: string) => void; onOpenSource: (path: string, line: number, column: number) => void;
}) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<PreviewTarget[]>([]);
  const [previews, setPreviews] = useState<PreviewSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [frameRevision, setFrameRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<PreviewTarget | null>(null);
  const [events, setEvents] = useState<PreviewEvent[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  const scope = `${workspaceDir}\0${token}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const selected = previews.find((preview) => preview.id === selectedId) || null;
  const selectionKey = `${scope}\0${selectedId || ""}\0${selected?.status || ""}`;
  const selectionRef = useRef({ key: selectionKey });
  if (selectionRef.current.key !== selectionKey) selectionRef.current = { key: selectionKey };
  const urlRef = useRef(url); urlRef.current = url;
  const ticketSequence = useRef(0);
  const api = useCallback(async (path: string, method = "GET", body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`/api/previews${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Workspace-Dir": encodeURIComponent(workspaceDir) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || t("preview.failed"));
    return result;
  }, [token, workspaceDir, t]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSelectedId(null); setUrl(null); setPreviews([]); setEvents([]); setError(null); setLoadError(null);
    setTargets([]); setConfirmTarget(null); setBusy(false); setExpiresAt(0);
    const refresh = async () => {
      try {
        const result = await api("", "GET", undefined, controller.signal);
        if (controller.signal.aborted) return;
        setTargets(result.targets || []); setPreviews(result.previews || []); setLoadError(null);
        setSelectedId((current) => current || result.previews?.find((item: PreviewSession) => item.status === "ready" || item.status === "starting")?.id || null);
      } catch (reason) { if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : t("preview.failed")); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 2000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, scope, t]);
  const openTicket = useCallback(async (id: string, renew = false): Promise<boolean> => {
    const requestedSelection = selectionRef.current;
    const sequence = ++ticketSequence.current;
    setError(null);
    const previousUrl = urlRef.current;
    const ticket = renew && previousUrl ? new URL(previousUrl).pathname.split("/")[3] : undefined;
    const result = await api(`/${encodeURIComponent(id)}/ticket`, "POST", ticket ? { ticket } : {});
    if (scopeRef.current !== scope || selectionRef.current !== requestedSelection || ticketSequence.current !== sequence) return false;
    const candidate = new URL(result.url, window.location.origin);
    if (candidate.origin !== window.location.origin || !candidate.pathname.startsWith(`/preview/${encodeURIComponent(id)}/`)) throw new Error(t("preview.failed"));
    setUrl(candidate.toString()); setExpiresAt(Number(result.expiresAt) || Date.now() + 60_000);
    if (!renew || candidate.toString() !== previousUrl) { setEvents([]); setInspecting(false); }
    return true;
  }, [api, scope, t]);
  useEffect(() => {
    const requestedSelection = selectionRef.current;
    setUrl(null); setEvents([]); setInspecting(false);
    if (selected?.status === "ready") void openTicket(selected.id).catch((reason) => { if (selectionRef.current === requestedSelection) setError(reason instanceof Error ? reason.message : t("preview.failed")); });
  }, [selected?.id, selected?.status, openTicket, t]);
  useEffect(() => {
    if (!url || !expiresAt || selected?.status !== "ready") return;
    const requestedSelection = selectionRef.current;
    const timer = setTimeout(() => {
      void openTicket(selected.id, true).catch((reason) => {
        if (selectionRef.current === requestedSelection) { setError(reason instanceof Error ? reason.message : t("preview.failed")); setExpiresAt(Date.now() + 45_000); }
      });
    }, Math.max(5000, expiresAt - Date.now() - 30_000));
    return () => clearTimeout(timer);
  }, [url, expiresAt, selected?.id, selected?.status, openTicket, t]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== "null" || !selected || selected.status !== "ready") return;
      const data = event.data;
      if (!data || data.type !== "crewforge:preview-event" || data.previewId !== selected.id || !["error", "console", "selection"].includes(data.kind)) return;
      const message = String(data.message || data.text || "").slice(0, 2000).replace(/\/preview\/[^/]+\/[^/]+\//g, "/preview/");
      const sourceCandidates = Array.isArray(data.sourceCandidates) ? data.sourceCandidates.filter((item: unknown) => Boolean(item && typeof item === "object" && "path" in item && typeof item.path === "string" && !item.path.startsWith("/") && !item.path.split(/[\\/]/).includes(".."))).slice(0, 3) : [];
      const item: PreviewEvent = { kind: data.kind, message, ...(typeof data.selector === "string" ? { selector: data.selector.slice(0, 500) } : {}), sourceCandidates };
      setEvents((current) => {
        const previous = current[current.length - 1];
        return previous && previous.kind === item.kind && previous.message === item.message && previous.selector === item.selector ? current : [...current.slice(-49), item];
      });
      if (data.kind === "selection") setInspecting(false);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [selected]);
  const start = async () => {
    if (!confirmTarget || readOnly || busy) return;
    setBusy(true); setError(null);
    const requestedSelection = selectionRef.current;
    try {
      const result = await api("", "POST", { targetId: confirmTarget.id });
      if (scopeRef.current !== scope) return;
      setPreviews((current) => [...current.filter((item) => item.id !== result.preview.id), result.preview]);
      if (selectionRef.current === requestedSelection) setSelectedId(result.preview.id);
      setConfirmTarget(null);
    } catch (reason) { if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : t("preview.failed")); }
    finally { if (scopeRef.current === scope) setBusy(false); }
  };
  const stop = async () => {
    if (!selected || readOnly) return;
    const requestedSelection = selectionRef.current;
    ticketSequence.current += 1;
    try { await api(`/${encodeURIComponent(selected.id)}`, "DELETE"); if (scopeRef.current !== scope) return; if (selectionRef.current === requestedSelection) setUrl(null); setPreviews((current) => current.map((item) => item.id === selected.id ? { ...item, status: "stopped" } : item)); }
    catch (reason) { if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : t("preview.failed")); }
  };
  return <aside className="web-preview-panel" aria-label={t("preview.title")}>
    <header><strong><Globe size={15} />{t("preview.title")}</strong><button type="button" onClick={onClose} aria-label={t("common.close")}><X size={16} /></button></header>
    <div className="web-preview-controls">
      <select aria-label={t("preview.select")} value={selectedId || ""} onChange={(event) => setSelectedId(event.target.value || null)}>
        <option value="">{t("preview.select")}</option>
        {previews.map((preview) => <option key={preview.id} value={preview.id}>{preview.label} · {t(`preview.status.${preview.status}`)}</option>)}
      </select>
      {selected && <><button type="button" disabled={selected.status !== "ready"} onClick={() => void openTicket(selected.id).then((applied) => { if (applied) setFrameRevision((value) => value + 1); }).catch((reason) => setError(String(reason)))} aria-label={t("common.refresh")}><RefreshCw size={15} /></button><button type="button" disabled={readOnly || !["ready", "starting"].includes(selected.status)} onClick={() => void stop()} aria-label={t("preview.stop")}><Square size={15} /></button></>}
    </div>
    <div className="web-preview-targets">{targets.map((target) => <button type="button" key={target.id} disabled={readOnly || busy} onClick={() => setConfirmTarget(target)}><Play size={12} />{target.label}</button>)}{!targets.length && <p>{t("preview.noTargets")}</p>}</div>
    {selected?.kind === "vite" && <p className="web-preview-config-note">{t("preview.configBoundary")}</p>}
    {error && <div className="web-preview-error" role="alert">{error}</div>}
    {loadError && <div className="web-preview-error" role="alert">{loadError}</div>}
    {selected?.error && <div className="web-preview-error" role="alert">{selected.error}</div>}
    {url ? <><button className="web-preview-inspect" type="button" aria-pressed={inspecting} onClick={() => { const enabled = !inspecting; setInspecting(enabled); iframe.current?.contentWindow?.postMessage({ type: "crewforge:preview-inspect", enabled }, "*"); }}><MousePointer2 size={14} />{t("preview.inspect")}</button><iframe key={frameRevision} ref={iframe} src={url} title={t("preview.title")} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" /></> : <div className="web-preview-empty">{selected?.status === "starting" ? t("preview.starting") : t("preview.hint")}</div>}
    {events.length > 0 && <details className="web-preview-events" open><summary>{t("preview.feedback")} ({events.length})</summary>
      {events.map((event, index) => <article key={index}><strong>{t(`preview.event.${event.kind}`)}</strong><pre>{event.selector ? `${event.selector}\n${event.message}` : event.message}</pre>
        {event.kind === "selection" && !event.sourceCandidates?.length && <small>{t("preview.mappingUnknown")}</small>}
        {event.sourceCandidates?.map((source) => <button key={source.path} type="button" onClick={() => {
          if (!selected) return;
          const requestedSelection = selectionRef.current;
          void api(`/${encodeURIComponent(selected.id)}/source`, "POST", { candidate: source }).then((result) => {
            if (scopeRef.current !== scope || selectionRef.current !== requestedSelection) return;
            const verified = result.sourceCandidates?.find((item: { verified?: boolean }) => item.verified === true);
            if (verified) onOpenSource(verified.path, verified.line || 1, verified.column || 1);
            else setError(t("preview.mappingUnknown"));
          }).catch((reason) => setError(reason instanceof Error ? reason.message : t("preview.failed")));
        }}>{source.path}:{source.line || 1}</button>)}
        <button type="button" onClick={() => onFeedback(`${t("preview.feedbackPrompt")}\n${JSON.stringify({ previewId: selected?.id, kind: event.kind, message: event.message, selector: event.selector, sourceCandidates: event.sourceCandidates?.map(({ path, line, column }) => ({ path, line, column })) }, null, 2)}`)}>{t("preview.sendFeedback")}</button>
      </article>)}
    </details>}
    <ActionConfirmDialog intent={confirmTarget ? { id: `preview:${confirmTarget.id}`, title: t("preview.start"), description: t("preview.startDescription", { name: confirmTarget.label }) } : null} busy={busy} error={error} onConfirm={start} onClose={() => setConfirmTarget(null)} />
  </aside>;
}
