import { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";

export interface EditorProblem {
  id: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
}

type MonacoApi = typeof import("monaco-editor");

function severityOf(
  value: Monaco.MarkerSeverity,
  api: MonacoApi
): EditorProblem["severity"] {
  if (value === api.MarkerSeverity.Error) return "error";
  if (value === api.MarkerSeverity.Warning) return "warning";
  return "info";
}

function markerPath(marker: Monaco.editor.IMarker): string {
  const value = decodeURIComponent(marker.resource.path || marker.resource.toString());
  return value.replace(/^\/+/, "");
}

export function useEditorProblems() {
  const [problems, setProblems] = useState<EditorProblem[]>([]);
  const monacoRef = useRef<MonacoApi | null>(null);

  const refresh = useCallback(() => {
    const api = monacoRef.current;
    if (!api) return;

    const next = api.editor
      .getModelMarkers({})
      .filter((marker) => marker.severity >= api.MarkerSeverity.Info)
      .map((marker, index) => ({
        id: `${marker.owner}:${marker.resource.toString()}:${marker.startLineNumber}:${marker.startColumn}:${index}`,
        path: markerPath(marker),
        line: marker.startLineNumber,
        column: marker.startColumn,
        endLine: marker.endLineNumber,
        endColumn: marker.endColumn,
        severity: severityOf(marker.severity, api),
        message: marker.message,
        source: marker.owner || "language-service",
      }));
    setProblems(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    let markerListener: Monaco.IDisposable | null = null;

    void import("monaco-editor").then((api) => {
      if (disposed) return;
      monacoRef.current = api;
      refresh();
      markerListener = api.editor.onDidChangeMarkers(refresh);
    });

    return () => {
      disposed = true;
      markerListener?.dispose();
      monacoRef.current = null;
    };
  }, [refresh]);

  return { problems, refresh };
}
