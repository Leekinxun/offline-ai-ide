import React, { useCallback, useEffect } from "react";
import MonacoEditor, { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { FileSelectionRange, OpenFile, SelectionInfo } from "../types";

interface NavigationTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}

interface DefinitionLocation {
  path: string;
  selection: FileSelectionRange;
}

interface EditorProps {
  content: string;
  language: string;
  path: string;
  openFiles: Pick<OpenFile, "path" | "content" | "language">[];
  onChange: (value: string) => void;
  onSave: () => void;
  onSelectionChange: (selection: SelectionInfo | null) => void;
  onNavigateToLocation: (
    path: string,
    selection: FileSelectionRange
  ) => Promise<void> | void;
  editorRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
  navigationTarget: NavigationTarget | null;
  onNavigationComplete: (requestId: number) => void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDefinitionMatchers(symbol: string, language: string): RegExp[] {
  const escaped = escapeRegExp(symbol);
  const baseMatchers = [
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:class|interface|type|enum)\\s+${escaped}\\b`),
    new RegExp(
      `^\\s*(?:(?:public|private|protected|internal|static|readonly|override|abstract|async|open|sealed|virtual|partial|final|synchronized|native)\\s+)*(?:[A-Za-z_][\\w<>,?.\\[\\]\\s]*\\s+)?${escaped}\\s*\\(`
    ),
  ];

  switch (language) {
    case "python":
      return [
        new RegExp(`^\\s*(?:async\\s+def|def|class)\\s+${escaped}\\b`),
        new RegExp(`^\\s*${escaped}\\s*=\\s*`),
      ];
    case "go":
      return [
        new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\b`),
        new RegExp(`^\\s*type\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:var|const)\\s+${escaped}\\b`),
      ];
    case "rust":
      return [
        new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:pub\\s+)?(?:struct|enum|trait|type|mod)\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:pub\\s+)?(?:const|static|let)\\s+${escaped}\\b`),
      ];
    case "java":
    case "kotlin":
    case "swift":
    case "c":
    case "cpp":
    case "csharp":
    case "php":
    case "ruby":
      return [
        new RegExp(`^\\s*(?:class|interface|enum|struct|trait|protocol)\\s+${escaped}\\b`),
        new RegExp(
          `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|open|sealed|partial|fun|func|def)\\s+)*(?:[A-Za-z_][\\w<>,?.\\[\\]\\s]*\\s+)?${escaped}\\s*\\(`
        ),
        new RegExp(`^\\s*(?:const|let|var|val)\\s+${escaped}\\b`),
      ];
    default:
      return baseMatchers;
  }
}

function findDefinitionInContent(
  content: string,
  language: string,
  symbol: string,
  currentPosition?: monaco.Position
): FileSelectionRange | null {
  const lines = content.split(/\r?\n/);
  const matchers = buildDefinitionMatchers(symbol, language);

  for (const matcher of matchers) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!matcher.test(line)) continue;

      const startColumn = line.indexOf(symbol) + 1;
      if (startColumn <= 0) continue;

      const selection = {
        startLine: index + 1,
        startColumn,
        endLine: index + 1,
        endColumn: startColumn + symbol.length,
      };

      if (
        currentPosition &&
        currentPosition.lineNumber === selection.startLine &&
        currentPosition.column >= selection.startColumn &&
        currentPosition.column <= selection.endColumn
      ) {
        continue;
      }

      return selection;
    }
  }

  return null;
}

function findDefinitionLocation(
  symbol: string,
  currentPath: string,
  currentPosition: monaco.Position,
  openFiles: Pick<OpenFile, "path" | "content" | "language">[]
): DefinitionLocation | null {
  const files = [
    ...openFiles.filter((file) => file.path === currentPath),
    ...openFiles.filter((file) => file.path !== currentPath),
  ];

  for (const file of files) {
    const selection = findDefinitionInContent(
      file.content,
      file.language,
      symbol,
      file.path === currentPath ? currentPosition : undefined
    );
    if (!selection) continue;
    return { path: file.path, selection };
  }

  return null;
}

export const Editor: React.FC<EditorProps> = ({
  content,
  language,
  path,
  openFiles,
  onChange,
  onSave,
  onSelectionChange,
  onNavigateToLocation,
  editorRef,
  navigationTarget,
  onNavigationComplete,
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

      editor.onMouseDown((event) => {
        const browserEvent = event.event.browserEvent;
        if (
          !(browserEvent.ctrlKey || browserEvent.metaKey) ||
          browserEvent.button !== 0 ||
          event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT ||
          !event.target.position
        ) {
          return;
        }

        const model = editor.getModel();
        if (!model) return;

        const word = model.getWordAtPosition(event.target.position);
        if (!word?.word) return;

        const location = findDefinitionLocation(
          word.word,
          path,
          event.target.position,
          openFiles
        );
        if (!location) return;

        browserEvent.preventDefault();
        browserEvent.stopPropagation();

        if (location.path === path) {
          const selection = new monaco.Selection(
            location.selection.startLine,
            location.selection.startColumn,
            location.selection.endLine,
            location.selection.endColumn
          );
          editor.focus();
          editor.setSelection(selection);
          editor.revealRangeInCenter(selection);
          return;
        }

        void onNavigateToLocation(location.path, location.selection);
      });

      editor.focus();
    },
    [
      editorRef,
      onNavigateToLocation,
      onSave,
      onSelectionChange,
      openFiles,
      path,
    ]
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !navigationTarget || navigationTarget.path !== path) return;

    const selection = new monaco.Selection(
      navigationTarget.startLine,
      navigationTarget.startColumn,
      navigationTarget.endLine,
      navigationTarget.endColumn
    );

    editor.focus();
    editor.setSelection(selection);
    editor.revealRangeInCenter(selection);
    onNavigationComplete(navigationTarget.requestId);
  }, [editorRef, navigationTarget, onNavigationComplete, path]);

  return (
    <div className="editor-container">
      <MonacoEditor
        key={path}
        height="100%"
        language={language}
        path={path}
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
