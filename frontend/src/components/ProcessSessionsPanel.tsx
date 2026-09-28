import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { useI18n } from "../i18n";
import { ActionConfirmDialog } from "./ActionConfirmDialog";

interface Task { id: string; label: string; }
interface Session { id: string; label: string; status: string; exitCode: number | null; }

export function ProcessSessionsPanel({ token, workspaceDir, readOnly = false }: { token: string; workspaceDir: string; readOnly?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [taskId, setTaskId] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);
  const scope = `${workspaceDir}\0${token}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const selected = sessions.find((session) => session.id === sessionId);
  const task = tasks.find((item) => item.id === taskId);
  useEffect(() => { setSessionId(null); setOutput(""); setSessions([]); cursor.current = 0; setError(null); setLoadError(null); }, [scope]);
  useEffect(() => { setOutput(""); cursor.current = 0; }, [sessionId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch("/api/process-sessions", { headers: { Authorization: `Bearer ${token}`, "X-Workspace-Dir": encodeURIComponent(workspaceDir) }, signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || t("process.failed"));
        if (controller.signal.aborted) return;
        setTasks(result.tasks || []); setSessions(result.sessions || []);
        if (sessionId) {
          const detail = await fetch(`/api/process-sessions/${encodeURIComponent(sessionId)}?cursor=${cursor.current}`, { headers: { Authorization: `Bearer ${token}`, "X-Workspace-Dir": encodeURIComponent(workspaceDir) }, signal: controller.signal });
          const payload = await detail.json();
          if (!detail.ok) throw new Error(payload.error || t("process.failed"));
          if (controller.signal.aborted) return;
          cursor.current = payload.nextCursor;
          const chunk = (payload.events || []).map((event: { text: string }) => event.text).join("");
          setOutput((current) => `${payload.truncated ? t("process.trimmed") + "\n" : ""}${current}${chunk}`.slice(-200_000));
        }
        setLoadError(null);
      } catch (reason) { if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : t("process.failed")); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 1000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, sessionId, token, workspaceDir, t]);
  const mutate = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`/api/process-sessions${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Workspace-Dir": encodeURIComponent(workspaceDir) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || t("process.failed"));
    if (scopeRef.current !== scope) throw new Error("Workspace changed");
    return payload;
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (reason) { if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : t("process.failed")); }
    finally { if (scopeRef.current === scope) setBusy(false); }
  };
  return <details className="process-sessions" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("process.title")}</summary>
    <div className="process-session-controls">
      <select aria-label={t("process.task")} value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">{t("process.task")}</option>{tasks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      <button type="button" className="dialog-btn" disabled={readOnly || busy || !task} onClick={() => setConfirm(true)}><Play size={12} />{t("process.start")}</button>
      <select aria-label={t("process.session")} value={sessionId || ""} onChange={(event) => setSessionId(event.target.value || null)}><option value="">{t("process.session")}</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.label} · {t(`process.status.${session.status}`)}</option>)}</select>
      {selected && <button type="button" className="dialog-btn" disabled={readOnly || busy || selected.status !== "running"} onClick={() => void perform(async () => { await mutate(`/${encodeURIComponent(selected.id)}`, "DELETE"); })}><Square size={12} />{t("process.stop")}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {selected && <><p>{t(`process.status.${selected.status}`)}{selected.exitCode !== null ? ` · exit ${selected.exitCode}` : ""}</p><pre className="run-output" aria-live="polite">{output || t("process.noOutput")}</pre>
      <form onSubmit={(event) => { event.preventDefault(); if (!input.trim()) return; void perform(async () => { await mutate(`/${encodeURIComponent(selected.id)}/input`, "POST", { text: `${input}\n` }); setInput(""); }); }}>
        <input aria-label={t("process.input")} placeholder={t("process.input")} value={input} onChange={(event) => setInput(event.target.value)} disabled={readOnly || busy || selected.status !== "running"} />
        <button className="dialog-btn" type="submit" disabled={readOnly || busy || selected.status !== "running" || !input.trim()}>{t("process.send")}</button>
      </form></>}
    <ActionConfirmDialog intent={confirm && task ? { id: task.id, title: t("process.start"), description: t("process.confirm", { name: task.label }) } : null} busy={busy} error={error} onClose={() => setConfirm(false)} onConfirm={() => perform(async () => { const result = await mutate("", "POST", { taskId }); setSessionId(result.session.id); setSessions((current) => [...current, result.session]); setConfirm(false); })} />
  </details>;
}
