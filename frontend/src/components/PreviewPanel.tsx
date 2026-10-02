import { useCallback, useEffect, useRef, useState } from "react";
import {
  Globe,
  MousePointer2,
  Play,
  RefreshCw,
  Square,
  X,
  ExternalLink,
  Copy,
  Check,
  Compass,
  AlertCircle,
  Terminal,
  ChevronDown,
} from "lucide-react";
import { useI18n } from "../i18n";
import { getDesktopBridge } from "../desktop/bridge";
import { ActionConfirmDialog } from "./ActionConfirmDialog";
import { WorkbenchSelect } from "./WorkbenchSelect";
import "./PreviewPanel.css";

interface PreviewTarget {
  id: string;
  label: string;
  kind: "vite" | "static";
  taskId?: string;
}

interface PreviewSession {
  id: string;
  targetId: string;
  label: string;
  kind: string;
  status: string;
  error?: string;
}

interface PreviewEvent {
  kind: "error" | "console" | "selection";
  message: string;
  selector?: string;
  sourceCandidates?: Array<{ path: string; line?: number; column?: number }>;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export function PreviewPanel({
  token,
  workspaceDir,
  readOnly,
  onClose,
  onFeedback,
  onOpenSource,
}: {
  token: string;
  workspaceDir: string;
  readOnly: boolean;
  onClose: () => void;
  onFeedback: (text: string) => void;
  onOpenSource: (path: string, line: number, column: number) => void;
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
  const [copiedUrl, setCopiedUrl] = useState(false);

  const iframe = useRef<HTMLIFrameElement>(null);
  const scope = `${workspaceDir}\0${token}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const selected = previews.find((preview) => preview.id === selectedId) || null;
  const selectionKey = `${scope}\0${selectedId || ""}\0${selected?.status || ""}`;
  const selectionRef = useRef({ key: selectionKey });
  if (selectionRef.current.key !== selectionKey) selectionRef.current = { key: selectionKey };
  const urlRef = useRef(url);
  urlRef.current = url;
  const ticketSequence = useRef(0);

  const api = useCallback(
    async (path: string, method = "GET", body?: unknown, signal?: AbortSignal) => {
      const response = await fetch(`/api/previews${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Workspace-Dir": encodeURIComponent(workspaceDir),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t("preview.failed"));
      return result;
    },
    [token, workspaceDir, t]
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSelectedId(null);
    setUrl(null);
    setPreviews([]);
    setEvents([]);
    setError(null);
    setLoadError(null);
    setTargets([]);
    setConfirmTarget(null);
    setBusy(false);
    setExpiresAt(0);

    const refresh = async () => {
      try {
        const result = await api("", "GET", undefined, controller.signal);
        if (controller.signal.aborted) return;
        setTargets(result.targets || []);
        setPreviews(result.previews || []);
        setLoadError(null);
        setSelectedId(
          (current) =>
            current ||
            result.previews?.find((item: PreviewSession) => item.status === "ready" || item.status === "starting")?.id ||
            null
        );
      } catch (reason) {
        if (!controller.signal.aborted) {
          setLoadError(reason instanceof Error ? reason.message : t("preview.failed"));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, scope, t]);

  const openTicket = useCallback(
    async (id: string, renew = false): Promise<boolean> => {
      const requestedSelection = selectionRef.current;
      const sequence = ++ticketSequence.current;
      setError(null);
      const previousUrl = urlRef.current;
      const ticket = renew && previousUrl ? new URL(previousUrl).pathname.split("/")[3] : undefined;
      const result = await api(`/${encodeURIComponent(id)}/ticket`, "POST", ticket ? { ticket } : {});
      if (scopeRef.current !== scope || selectionRef.current !== requestedSelection || ticketSequence.current !== sequence) {
        return false;
      }
      const candidate = new URL(result.url, window.location.origin);
      if (candidate.origin !== window.location.origin || !candidate.pathname.startsWith(`/preview/${encodeURIComponent(id)}/`)) {
        throw new Error(t("preview.failed"));
      }
      setUrl(candidate.toString());
      setExpiresAt(Number(result.expiresAt) || Date.now() + 60_000);
      if (!renew || candidate.toString() !== previousUrl) {
        setEvents([]);
        setInspecting(false);
      }
      return true;
    },
    [api, scope, t]
  );

  useEffect(() => {
    const requestedSelection = selectionRef.current;
    setUrl(null);
    setEvents([]);
    setInspecting(false);
    if (selected?.status === "ready") {
      void openTicket(selected.id).catch((reason) => {
        if (selectionRef.current === requestedSelection) {
          setError(reason instanceof Error ? reason.message : t("preview.failed"));
        }
      });
    }
  }, [selected?.id, selected?.status, openTicket, t]);

  useEffect(() => {
    if (!url || !expiresAt || selected?.status !== "ready") return;
    const requestedSelection = selectionRef.current;
    const timer = setTimeout(() => {
      void openTicket(selected.id, true).catch((reason) => {
        if (selectionRef.current === requestedSelection) {
          setError(reason instanceof Error ? reason.message : t("preview.failed"));
          setExpiresAt(Date.now() + 45_000);
        }
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
      const sourceCandidates = Array.isArray(data.sourceCandidates)
        ? data.sourceCandidates.filter((item: unknown) => Boolean(item && typeof item === "object" && "path" in item && typeof item.path === "string" && !item.path.startsWith("/") && !item.path.split(/[\\/]/).includes(".."))).slice(0, 3)
        : [];
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
    setBusy(true);
    setError(null);
    const requestedSelection = selectionRef.current;
    try {
      const result = await api("", "POST", { targetId: confirmTarget.id });
      if (scopeRef.current !== scope) return;
      setPreviews((current) => [...current.filter((item) => item.id !== result.preview.id), result.preview]);
      if (selectionRef.current === requestedSelection) setSelectedId(result.preview.id);
      setConfirmTarget(null);
    } catch (reason) {
      if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : t("preview.failed"));
    } finally {
      if (scopeRef.current === scope) setBusy(false);
    }
  };

  const stop = async () => {
    if (!selected || readOnly) return;
    const requestedSelection = selectionRef.current;
    ticketSequence.current += 1;
    try {
      await api(`/${encodeURIComponent(selected.id)}`, "DELETE");
      if (scopeRef.current !== scope) return;
      if (selectionRef.current === requestedSelection) setUrl(null);
      setPreviews((current) => current.map((item) => (item.id === selected.id ? { ...item, status: "stopped" } : item)));
    } catch (reason) {
      if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : t("preview.failed"));
    }
  };

  const handleCopyUrl = async () => {
    if (!url) return;
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1500);
    }
  };

  // 生成下拉选项
  const selectOptions = [
    { value: "", label: t("preview.select") },
    ...previews.map((preview) => ({
      value: preview.id,
      label: `${preview.label} · ${t(`preview.status.${preview.status}`)}`,
    })),
  ];

  const isReady = selected?.status === "ready";
  const isStarting = selected?.status === "starting";

  return (
    <aside className="web-preview-panel" aria-label={t("preview.title")}>
      {/* 顶栏：微卡浅蓝图标、标题、状态徽标及右侧操作按钮组 */}
      <header className="web-preview-header">
        <div className="web-preview-header-left">
          <div className="web-preview-brand-icon">
            <Globe size={14} />
          </div>
          <span className="web-preview-header-title">{t("preview.title")}</span>
          {selected && (
            <span className={`web-preview-status-pill ${selected.status}`}>
              <span className="web-preview-status-dot" />
              <span>{t(`preview.status.${selected.status}`)}</span>
            </span>
          )}
        </div>

        <div className="web-preview-header-actions">
          {selected && (
            <>
              {url && (
                <button
                  type="button"
                  className={`web-preview-action-btn${inspecting ? " active" : ""}`}
                  aria-pressed={inspecting}
                  onClick={() => {
                    const enabled = !inspecting;
                    setInspecting(enabled);
                    iframe.current?.contentWindow?.postMessage({ type: "crewforge:preview-inspect", enabled }, "*");
                  }}
                  title={t("preview.inspect")}
                >
                  <MousePointer2 size={13} />
                </button>
              )}

              <button
                type="button"
                className="web-preview-action-btn"
                disabled={!isReady}
                onClick={() =>
                  void openTicket(selected.id)
                    .then((applied) => {
                      if (applied) setFrameRevision((value) => value + 1);
                    })
                    .catch((reason) => setError(String(reason)))
                }
                title={t("common.refresh")}
              >
                <RefreshCw size={13} />
              </button>

              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="web-preview-action-btn link-btn"
                  title={t("preview.openExternal")}
                  onClick={(event) => {
                    const desktop = getDesktopBridge();
                    if (!desktop) return;
                    event.preventDefault();
                    void desktop.openExternal(url)
                      .then((opened) => { if (!opened) setError(t("preview.externalFailed")); })
                      .catch(() => setError(t("preview.externalFailed")));
                  }}
                >
                  <ExternalLink size={13} />
                </a>
              )}

              <button
                type="button"
                className="web-preview-action-btn danger"
                disabled={readOnly || !["ready", "starting"].includes(selected.status)}
                onClick={() => void stop()}
                title={t("preview.stop")}
              >
                <Square size={13} />
              </button>
            </>
          )}

          <button
            type="button"
            className="web-preview-action-btn close-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* 控制栏：微卡下拉选择器及快速目标 */}
      <div className="web-preview-controls-bar">
        <div className="web-preview-select-wrap">
          <WorkbenchSelect
            label={t("preview.select")}
            value={selectedId || ""}
            onChange={(val) => setSelectedId(val || null)}
            options={selectOptions}
          />
        </div>
      </div>

      {/* 仿浏览器微胶囊地址栏（运行就绪时） */}
      {url && isReady && (
        <div className="web-preview-address-bar">
          <div className="web-preview-address-capsule">
            <Compass size={12} className="web-preview-address-icon" />
            <span className="web-preview-address-text" title={url}>
              {url}
            </span>
            <button
              type="button"
              className="web-preview-copy-btn"
              onClick={handleCopyUrl}
              title={copiedUrl ? "已复制" : "复制链接"}
            >
              {copiedUrl ? <Check size={11} className="copied" /> : <Copy size={11} />}
            </button>
          </div>
        </div>
      )}

      {/* 警告/错误信息 */}
      {selected?.kind === "vite" && <p className="web-preview-config-note">{t("preview.configBoundary")}</p>}
      {error && (
        <div className="web-preview-alert error" role="alert">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}
      {loadError && (
        <div className="web-preview-alert error" role="alert">
          <AlertCircle size={13} />
          <span>{loadError}</span>
        </div>
      )}
      {selected?.error && (
        <div className="web-preview-alert error" role="alert">
          <AlertCircle size={13} />
          <span>{selected.error}</span>
        </div>
      )}

      {/* 视口内容区：iframe 或美化的居中空状态 */}
      <div className="web-preview-viewport">
        {url && isReady ? (
          <iframe
            key={frameRevision}
            ref={iframe}
            src={url}
            title={t("preview.title")}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            className="web-preview-iframe"
          />
        ) : isStarting ? (
          <div className="web-preview-empty-state starting">
            <div className="web-preview-empty-icon starting-glow">
              <RefreshCw size={24} className="spinning" />
            </div>
            <h4>{t("preview.starting")}</h4>
            <p>正在拉起本地 Web 预览服务，请稍候...</p>
          </div>
        ) : (
          <div className="web-preview-empty-state">
            <div className="web-preview-empty-icon">
              <Globe size={28} />
            </div>
            <h4>暂无运行中的 Web 预览</h4>
            <p className="web-preview-empty-desc">
              选择或启动一个开发预览目标，在编辑器内实时预览与调试页面交互
            </p>

            {targets.length > 0 ? (
              <div className="web-preview-targets-grid">
                <div className="web-preview-targets-title">可启动的目标</div>
                <div className="web-preview-targets-list">
                  {targets.map((target) => (
                    <button
                      type="button"
                      key={target.id}
                      className="web-preview-target-card"
                      disabled={readOnly || busy}
                      onClick={() => setConfirmTarget(target)}
                    >
                      <div className="web-preview-target-icon">
                        <Play size={12} />
                      </div>
                      <span className="web-preview-target-name">{target.label}</span>
                      <span className="web-preview-target-kind">{target.kind}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="web-preview-no-targets-box">
                <Terminal size={14} />
                <span>{t("preview.noTargets")}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 调试事件与元素检查反馈面板 */}
      {events.length > 0 && (
        <details className="web-preview-events" open>
          <summary className="web-preview-events-summary">
            <span>{t("preview.feedback")} ({events.length})</span>
            <ChevronDown size={13} className="chevron" />
          </summary>
          <div className="web-preview-events-list">
            {events.map((event, index) => (
              <article key={index} className={`web-preview-event-card ${event.kind}`}>
                <div className="web-preview-event-head">
                  <span className="web-preview-event-kind-badge">{t(`preview.event.${event.kind}`)}</span>
                </div>
                <pre>{event.selector ? `${event.selector}\n${event.message}` : event.message}</pre>
                {event.kind === "selection" && !event.sourceCandidates?.length && (
                  <small>{t("preview.mappingUnknown")}</small>
                )}
                {event.sourceCandidates?.length ? (
                  <div className="web-preview-candidates-row">
                    {event.sourceCandidates.map((source) => (
                      <button
                        key={source.path}
                        type="button"
                        className="web-preview-candidate-btn"
                        onClick={() => {
                          if (!selected) return;
                          const requestedSelection = selectionRef.current;
                          void api(`/${encodeURIComponent(selected.id)}/source`, "POST", { candidate: source })
                            .then((result) => {
                              if (scopeRef.current !== scope || selectionRef.current !== requestedSelection) return;
                              const verified = result.sourceCandidates?.find(
                                (item: { verified?: boolean }) => item.verified === true
                              );
                              if (verified) onOpenSource(verified.path, verified.line || 1, verified.column || 1);
                              else setError(t("preview.mappingUnknown"));
                            })
                            .catch((reason) => setError(reason instanceof Error ? reason.message : t("preview.failed")));
                        }}
                      >
                        {source.path}:{source.line || 1}
                      </button>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="web-preview-feedback-send-btn"
                  onClick={() =>
                    onFeedback(
                      `${t("preview.feedbackPrompt")}\n${JSON.stringify(
                        {
                          previewId: selected?.id,
                          kind: event.kind,
                          message: event.message,
                          selector: event.selector,
                          sourceCandidates: event.sourceCandidates?.map(({ path, line, column }) => ({
                            path,
                            line,
                            column,
                          })),
                        },
                        null,
                        2
                      )}`
                    )
                  }
                >
                  {t("preview.sendFeedback")}
                </button>
              </article>
            ))}
          </div>
        </details>
      )}

      <ActionConfirmDialog
        intent={
          confirmTarget
            ? {
                id: `preview:${confirmTarget.id}`,
                title: t("preview.start"),
                description: t("preview.startDescription", { name: confirmTarget.label }),
              }
            : null
        }
        busy={busy}
        error={error}
        onConfirm={start}
        onClose={() => setConfirmTarget(null)}
      />
    </aside>
  );
}
