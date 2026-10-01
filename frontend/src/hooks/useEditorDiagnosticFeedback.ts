import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { EditorProblem } from "./useEditorProblems";
import { buildEditorDiagnosticPayload, diagnosticModelPath, type DiagnosticFile } from "../editor/editorDiagnosticPolicy";

interface EditorDiagnosticFeedbackInput {
  token: string;
  workspaceDir: string;
  file: DiagnosticFile | null | undefined;
  problems: readonly EditorProblem[];
  /** Disabling retracts this hook's last snapshot without touching other publishers. */
  enabled?: boolean;
}

export function useEditorDiagnosticFeedback({ token, workspaceDir, file, problems, enabled = true }: EditorDiagnosticFeedbackInput) {
  const [status, setStatus] = useState<"idle" | "pending" | "sent" | "unavailable" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [publisherId] = useState(() => globalThis.crypto?.randomUUID?.() ?? `editor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sequenceRef = useRef(0);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [modelEpoch, setModelEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false; const subscriptions: Monaco.IDisposable[] = [];
    void import("monaco-editor").then((api) => {
      if (cancelled) return;
      monacoRef.current = api;
      setModelEpoch((value) => value + 1);
      const changed = () => setModelEpoch((value) => value + 1);
      subscriptions.push(api.editor.onDidCreateModel(changed), api.editor.onWillDisposeModel(changed));
    });
    return () => { cancelled = true; for (const subscription of subscriptions) subscription.dispose(); monacoRef.current = null; };
  }, []);

  useEffect(() => {
    setError(null);
    const api = monacoRef.current;
    if (!enabled || !token || !file || file.modified || !file.version || !api) { setStatus("idle"); return; }
    const currentFile = file;
    const path = diagnosticModelPath(currentFile.path, workspaceDir);
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    let cancelled = false; let sent = false;
    setStatus("pending");
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const model = api.editor.getModels().find((candidate) => !candidate.isDisposed()
            && diagnosticModelPath(decodeURIComponent(candidate.uri.path), workspaceDir) === path);
          if (!model || !globalThis.crypto?.subtle) { if (!cancelled) setStatus("unavailable"); return; }
          const modelSnapshot = { uri: model.uri.toString(), path: decodeURIComponent(model.uri.path), version: model.getVersionId(), content: model.getValue() };
          const bytes = new TextEncoder().encode(modelSnapshot.content);
          if (bytes.byteLength > 1024 * 1024) { if (!cancelled) setStatus("unavailable"); return; }
          const digest = await crypto.subtle.digest("SHA-1", bytes);
          const contentVersion = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
          if (cancelled || model.isDisposed() || model.getVersionId() !== modelSnapshot.version || model.getValue() !== modelSnapshot.content) return;
          const payload = buildEditorDiagnosticPayload({ workspaceDir, file: currentFile, model: modelSnapshot, contentVersion, problems, publisherId, sequence });
          if (!payload) { setStatus("unavailable"); return; }
          sent = true;
          const response = await fetch("/api/editor-diagnostics", { method: "POST", signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
          if (cancelled) return;
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            if (response.status === 403 || response.status === 409) { setStatus("unavailable"); return; }
            throw new Error(body.error || "Editor diagnostic feedback was not accepted");
          }
          setStatus("sent");
        } catch (reason) {
          if (!cancelled) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Editor diagnostic feedback failed"); }
        }
      })();
    }, 600);
    return () => {
      cancelled = true; window.clearTimeout(timer); controller.abort();
      if (!sent) return;
      const sequence = ++sequenceRef.current;
      void fetch("/api/editor-diagnostics", { method: "DELETE", keepalive: true,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceDir, path, publisherId, sequence }),
      }).catch(() => { /* Authentication/workspace changes may prevent cleanup; server TTL bounds retention. */ });
    };
  }, [token, workspaceDir, file?.path, file?.content, file?.version, file?.modified, problems, enabled, publisherId, modelEpoch]);

  return { status, error };
}
