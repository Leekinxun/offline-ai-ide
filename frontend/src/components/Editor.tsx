import React, { useCallback } from "react";
import MonacoEditor, { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { SelectionInfo } from "../types";

interface EditorProps {
  content: string;
  language: string;
  path: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onSelectionChange: (selection: SelectionInfo | null) => void;
  editorRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
}

export const Editor: React.FC<EditorProps> = ({
  content,
  language,
  path,
  onChange,
  onSave,
  onSelectionChange,
  editorRef,
}) => {
  const handleMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;

      // Cmd/Ctrl + S to save
      editor.addAction({
        id: "save-file",
        label: "Save File",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSave(),
      });

      // Track selection changes
      editor.onDidChangeCursorSelection(() => {
        const selection = editor.getSelection();
        if (selection && !selection.isEmpty()) {
          const text = editor.getModel()?.getValueInRange(selection) || "";
          if (text.trim()) {
            onSelectionChange({
              text,
              startLine: selection.startLineNumber,
              endLine: selection.endLineNumber,
            });
            return;
          }
        }
        onSelectionChange(null);
      });

      editor.focus();
    },
    [editorRef, onSave, onSelectionChange]
  );

  return (
    <div className="editor-container">
      <MonacoEditor
        key={path}
        height="100%"
        language={language}
        value={content}
        onChange={(val) => onChange(val ?? "")}
        onMount={handleMount}
        theme="vs"
        options={{
          fontSize: 13,
          fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
          fontLigatures: true,
          lineHeight: 20,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderLineHighlight: "line",
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          smoothScrolling: true,
          padding: { top: 12 },
          bracketPairColorization: { enabled: true },
          automaticLayout: true,
          wordWrap: "on",
          tabSize: 2,
          insertSpaces: true,
          roundedSelection: true,
          renderWhitespace: "selection",
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
        }}
      />
    </div>
  );
};
