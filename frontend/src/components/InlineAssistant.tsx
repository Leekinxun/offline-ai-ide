import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as monaco from "monaco-editor";
import { Check, CornerDownLeft, LoaderCircle, Sparkles, Square, X } from "lucide-react";
import { useI18n } from "../i18n";
import {
  createInlineAssistantRequest,
  extractInlineCode,
  getInlineApplyState,
  isInlineTargetCurrent,
  type InlineAssistantRequest,
  type InlineAssistantResponse,
  type InlineAssistantTarget,
  type InlineDocumentState,
} from "../editor/inlineAssistantPolicy";
import {
  isDisposedInlineAssistantContextError,
  isInlineAssistantEditorUsable,
} from "../editor/inlineAssistantLifecycle";
import "./InlineAssistant.css";

export interface InlineAssistantBindings {
  onInlineSubmit?: (request: InlineAssistantRequest) => boolean | void | Promise<boolean | void>;
  onInlineCancel?: (requestId: string) => void;
  inlineResponse?: InlineAssistantResponse | null;
  inlineDisabled?: boolean;
  inlineModelKey?: string;
}

interface InlineAssistantProps extends InlineAssistantBindings {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  path: string;
  language: string;
  dirty?: boolean;
  readOnly?: boolean;
}

export const InlineAssistant: React.FC<InlineAssistantProps> = (props) => {
  const { editor, inlineResponse, onInlineSubmit } = props;
  const { t } = useI18n();
  const titleId = useId();
  const inputId = useId();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<InlineAssistantTarget | null>(null);
  const [instruction, setInstruction] = useState("");
  const [request, setRequest] = useState<InlineAssistantRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setDocumentRevision] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const widgetRef = useRef<monaco.editor.IContentWidget | null>(null);
  const visibleContextRef = useRef<monaco.editor.IContextKey<boolean> | null>(null);
  const pendingRef = useRef<InlineAssistantRequest | null>(null);
  const targetRef = useRef(target);
  const propsRef = useRef(props);
  targetRef.current = target;
  propsRef.current = props;

  const cancelPending = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) propsRef.current.onInlineCancel?.(pending.id);
  }, []);

  const captureTarget = useCallback((): InlineAssistantTarget | null => {
    const current = propsRef.current;
    if (!isInlineAssistantEditorUsable(current.editor)) return null;
    const model = current.editor.getModel();
    const selection = current.editor.getSelection();
    if (!model || model.isDisposed() || !selection) return null;
    return {
      path: current.path,
      language: current.language,
      modelUri: model.uri.toString(),
      modelVersion: model.getVersionId(),
      fullModelSnapshot: model.getValue(),
      selection: {
        startLine: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLine: selection.endLineNumber,
        endColumn: selection.endColumn,
      },
      selectedText: model.getValueInRange(selection),
      dirty: current.dirty ?? false,
      modelKey: current.inlineModelKey,
    };
  }, []);

  const currentDocument = useCallback((): InlineDocumentState | null => {
    const current = propsRef.current;
    if (!isInlineAssistantEditorUsable(current.editor)) return null;
    const model = current.editor.getModel();
    if (!model || model.isDisposed()) return null;
    return {
      path: current.path,
      language: current.language,
      modelUri: model.uri.toString(),
      modelVersion: model.getVersionId(),
      fullModelSnapshot: model.getValue(),
      modelKey: current.inlineModelKey,
      readOnly: Boolean(current.readOnly || current.editor?.getOption(monaco.editor.EditorOption.readOnly)),
    };
  }, []);

  const close = useCallback(() => {
    cancelPending();
    targetRef.current = null;
    setTarget(null);
    setRequest(null);
    setBusy(false);
    setError(null);
    if (isInlineAssistantEditorUsable(propsRef.current.editor)) {
      propsRef.current.editor.focus();
    }
  }, [cancelPending]);

  const open = useCallback(() => {
    if (!targetRef.current) {
      const next = captureTarget();
      if (!next) return;
      targetRef.current = next;
      setTarget(next);
      setRequest(null);
      setInstruction("");
      setError(null);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [captureTarget]);

  useEffect(() => {
    if (!isInlineAssistantEditorUsable(editor) || !onInlineSubmit) return;
    let disposed = false;
    const node = document.createElement("div");
    node.className = "inline-assistant-host";
    const updateWidth = () => {
      node.style.width = `${Math.min(540, Math.max(280, editor.getLayoutInfo().width - 32), window.innerWidth - 24)}px`;
    };
    updateWidth();
    const widget: monaco.editor.IContentWidget = {
      getId: () => "crewforge.inline-assistant",
      getDomNode: () => node,
      allowEditorOverflow: true,
      suppressMouseDown: false,
      getPosition: () => {
        const anchor = targetRef.current;
        const model = editor.getModel();
        if (!anchor || !model || model.isDisposed()) return null;
        return {
          position: model.validatePosition({ lineNumber: anchor.selection.endLine, column: anchor.selection.endColumn }),
          preference: [monaco.editor.ContentWidgetPositionPreference.BELOW, monaco.editor.ContentWidgetPositionPreference.ABOVE],
        };
      },
    };
    widgetRef.current = widget;
    const disposeSubscription = editor.onDidDispose(() => {
      disposed = true;
      if (widgetRef.current === widget) {
        widgetRef.current = null;
        visibleContextRef.current = null;
      }
      cancelPending();
      targetRef.current = null;
      setTarget(null);
      setRequest(null);
      setBusy(false);
      setError(null);
      setHost((current) => current === node ? null : current);
    });
    if (!isInlineAssistantEditorUsable(editor)) {
      disposeSubscription.dispose();
      return;
    }
    try {
      visibleContextRef.current = editor.createContextKey("crewforgeInlineAssistantVisible", Boolean(targetRef.current));
    } catch (reason) {
      disposeSubscription.dispose();
      if (widgetRef.current === widget) {
        widgetRef.current = null;
        visibleContextRef.current = null;
      }
      if (isDisposedInlineAssistantContextError(reason)) return;
      throw reason;
    }
    editor.addContentWidget(widget);
    setHost(node);
    const relayout = () => { if (!disposed && isInlineAssistantEditorUsable(editor)) editor.layoutContentWidget(widget); };
    const actions = [
      editor.addAction({
        id: "crewforge.inline-assistant.open",
        label: t("inline.open"),
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
        contextMenuGroupId: "modification",
        contextMenuOrder: 1,
        run: open,
      }),
      editor.addAction({
        id: "crewforge.inline-assistant.close",
        label: t("inline.close"),
        keybindings: [monaco.KeyCode.Escape],
        precondition: "crewforgeInlineAssistantVisible",
        run: close,
      }),
      editor.onDidChangeModelContent(() => setDocumentRevision((value) => value + 1)),
      editor.onDidChangeModel(() => { setDocumentRevision((value) => value + 1); relayout(); }),
      editor.onDidLayoutChange(() => { updateWidth(); relayout(); }),
      disposeSubscription,
    ];
    const resize = new ResizeObserver(relayout);
    resize.observe(node);
    return () => {
      cancelPending();
      targetRef.current = null;
      setTarget(null);
      setRequest(null);
      setBusy(false);
      setError(null);
      resize.disconnect();
      for (const action of actions) action.dispose();
      if (!disposed && isInlineAssistantEditorUsable(editor)) editor.removeContentWidget(widget);
      if (widgetRef.current === widget) widgetRef.current = null;
      if (!disposed && isInlineAssistantEditorUsable(editor)) visibleContextRef.current?.reset();
      visibleContextRef.current = null;
      setHost((current) => current === node ? null : current);
    };
  }, [editor, Boolean(onInlineSubmit), open, close, cancelPending, t]);

  useEffect(() => {
    if (isInlineAssistantEditorUsable(editor)) {
      visibleContextRef.current?.set(Boolean(target));
      if (widgetRef.current) editor.layoutContentWidget(widgetRef.current);
    } else {
      visibleContextRef.current = null;
      widgetRef.current = null;
    }
    if (target) requestAnimationFrame(() => inputRef.current?.focus());
  }, [editor, host, target]);

  useEffect(() => {
    if (!request || inlineResponse?.requestId !== request.id || inlineResponse.status === "streaming") return;
    if (pendingRef.current?.id === request.id) pendingRef.current = null;
    setBusy(false);
  }, [inlineResponse, request]);

  useEffect(() => () => {
    cancelPending();
  }, [cancelPending]);

  const submit = async () => {
    if (pendingRef.current || propsRef.current.inlineDisabled || !instruction.trim() || !propsRef.current.onInlineSubmit) return;
    const nextTarget = captureTarget();
    if (!nextTarget) return;
    const requestId = globalThis.crypto?.randomUUID?.() ?? `inline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const next = createInlineAssistantRequest(nextTarget, instruction, requestId);
    pendingRef.current = next;
    targetRef.current = nextTarget;
    setTarget(nextTarget);
    setRequest(next);
    setBusy(true);
    setError(null);
    try {
      const accepted = await propsRef.current.onInlineSubmit(next);
      if (accepted === false && pendingRef.current?.id === next.id) {
        pendingRef.current = null;
        setBusy(false);
        setError(t("inline.unavailable"));
      }
    } catch (reason) {
      if (pendingRef.current?.id !== next.id) return;
      pendingRef.current = null;
      setBusy(false);
      setError(reason instanceof Error ? reason.message : t("inline.failed"));
    }
  };

  const response = request && inlineResponse?.requestId === request.id ? inlineResponse : null;
  const documentState = currentDocument();
  const stale = Boolean(target && (!documentState || !isInlineTargetCurrent(target, documentState)));
  const candidate = extractInlineCode(response?.text ?? "", response?.status === "completed");
  const applyState = getInlineApplyState(request, response, documentState);

  const accept = () => {
    const current = propsRef.current;
    const check = getInlineApplyState(request, current.inlineResponse, currentDocument());
    const activeEditor = current.editor;
    if (pendingRef.current || !check.allowed || !request || !isInlineAssistantEditorUsable(activeEditor)) {
      if (!check.allowed) setError(t(`inline.${check.reason}`));
      return;
    }
    const range = new monaco.Range(
      request.selection.startLine, request.selection.startColumn,
      request.selection.endLine, request.selection.endColumn,
    );
    activeEditor.pushUndoStop();
    const applied = activeEditor.executeEdits("inline-assistant", [{ range, text: check.replacement, forceMoveMarkers: true }]);
    activeEditor.pushUndoStop();
    if (!applied) { setError(t("inline.failed")); return; }
    close();
  };

  if (!target || !host) return null;
  const message = error || response?.error
    || (stale ? t("inline.stale") : props.readOnly ? t("inline.readonly")
      : response?.status === "cancelled" ? t("inline.cancelled")
        : response?.status === "error" ? t("inline.failed")
          : response?.status === "completed" && !applyState.allowed ? t(`inline.${applyState.reason}`) : null);
  return createPortal(
    <section
      className="inline-assistant"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-busy={busy}
      data-testid="inline-assistant"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          if (applyState.allowed && !busy) accept();
          else void submit();
        }
      }}
    >
      <header className="inline-assistant-header">
        <Sparkles size={15} aria-hidden="true" />
        <strong id={titleId}>{t("inline.title")}</strong>
        <span className="inline-assistant-scope">{t(target.selectedText ? "inline.selection" : "inline.cursor", { start: target.selection.startLine, end: target.selection.endLine })}</span>
        <button type="button" className="inline-assistant-icon" onClick={close} aria-label={t(busy ? "inline.stopClose" : "inline.close")} title="Esc"><X size={15} /></button>
      </header>
      <label htmlFor={inputId} className="sr-only">{t("inline.instruction")}</label>
      <textarea
        ref={inputRef}
        id={inputId}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder={t("inline.placeholder")}
        rows={2}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {target.selectedText && candidate.kind !== "partial" && candidate.kind !== "complete" && <details className="inline-assistant-original"><summary>{t("inline.original")}{target.dirty ? ` · ${t("inline.unsaved")}` : ""}</summary><pre>{target.selectedText}</pre></details>}
      {(candidate.kind === "partial" || candidate.kind === "complete") && <div className="inline-assistant-comparison">
        {target.selectedText && <div className="inline-assistant-before"><span>{t("inline.original")}{target.dirty ? ` · ${t("inline.unsaved")}` : ""}</span><pre>{target.selectedText}</pre></div>}
        <div className="inline-assistant-proposal">
          <span>{t("inline.proposal")}{busy ? ` · ${t("inline.streaming")}` : ""}</span>
          <pre data-testid="inline-assistant-candidate">{candidate.code || t("inline.deleteSelection")}</pre>
        </div>
      </div>}
      {message && <p className="inline-assistant-notice" role="status" aria-live="polite">{message}</p>}
      {candidate.kind === "invalid" && response?.text && <details className="inline-assistant-original"><summary>{t("inline.rawResponse")}</summary><pre>{response.text}</pre></details>}
      <footer className="inline-assistant-footer">
        <span>{t("inline.bufferOnly")}</span>
        <div>
          {busy ? <button type="button" onClick={close}><Square size={12} />{t("inline.stop")}</button>
            : <button type="button" onClick={() => void submit()} disabled={!instruction.trim() || props.inlineDisabled}>
              <CornerDownLeft size={13} />{t(request ? "inline.regenerate" : "inline.generate")}
            </button>}
          <button type="button" className="inline-assistant-accept" onClick={accept} disabled={busy || !applyState.allowed} title="Ctrl/Cmd+Enter">
            {busy ? <LoaderCircle size={13} className="inline-assistant-spinner" /> : <Check size={13} />}{t("inline.accept")}
          </button>
        </div>
      </footer>
    </section>, host,
  );
};
