import React, { useCallback, useEffect, useRef } from "react";
import MonacoEditor, { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  DefinitionLocation,
  FileSelectionRange,
  OpenFile,
  SelectionInfo,
} from "../types";
import { getEditorThemeName } from "../editor/theme";
import { useI18n } from "../i18n";
import { runEditorMountHandlers } from "../plugins/runtime";

interface NavigationTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}

interface HighlightTarget extends FileSelectionRange {
  path: string;
  requestId: number;
}

interface EditorProps {
  content: string;
  language: string;
  path: string;
  theme: "light" | "dark";
  openFiles: Pick<OpenFile, "path" | "content" | "language">[];
  onChange: (value: string) => void;
  onSave: () => void;
  onSelectionChange: (selection: SelectionInfo | null) => void;
  onNavigateToLocation: (
    path: string,
    selection: FileSelectionRange
  ) => Promise<void> | void;
  onFindDefinition: (
    symbol: string,
    currentPath: string
  ) => Promise<DefinitionLocation | null>;
  editorRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
  navigationTarget: NavigationTarget | null;
  highlightTarget: HighlightTarget | null;
  onNavigationComplete: (requestId: number) => void;
  onHighlightComplete: (requestId: number) => void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDefinitionMatchers(symbol: string, language: string): RegExp[] {
  const escaped = escapeRegExp(symbol);
  const baseMatchers = [
    new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`
    ),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:class|interface|type|enum)\\s+${escaped}\\b`
    ),
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

function createHighlightRange(
  selection: FileSelectionRange
): monaco.Range {
  const endLine = Math.max(selection.endLine, selection.startLine);
  const endColumn =
    selection.endLine === selection.startLine &&
    selection.endColumn <= selection.startColumn
      ? selection.startColumn + 1
      : Math.max(selection.endColumn, 1);

  return new monaco.Range(
    selection.startLine,
    Math.max(selection.startColumn, 1),
    endLine,
    endColumn
  );
}

function isIdentifierLike(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function rangesMatch(left: monaco.IRange, right: monaco.IRange): boolean {
  return (
    left.startLineNumber === right.startLineNumber &&
    left.startColumn === right.startColumn &&
    left.endLineNumber === right.endLineNumber &&
    left.endColumn === right.endColumn
  );
}

export const Editor: React.FC<EditorProps> = ({
  content,
  language,
  path,
  theme,
  openFiles,
  onChange,
  onSave,
  onSelectionChange,
  onNavigateToLocation,
  onFindDefinition,
  editorRef,
  navigationTarget,
  highlightTarget,
  onNavigationComplete,
  onHighlightComplete,
}) => {
  const onSaveRef = useRef(onSave);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const highlightDecorationIdsRef = useRef<string[]>([]);
  const highlightTimerRef = useRef<number | null>(null);
  const symbolDecorationIdsRef = useRef<string[]>([]);
  const pluginCleanupRef = useRef<(() => void) | null>(null);
  const { locale, t } = useI18n();

  onSaveRef.current = onSave;
  onSelectionChangeRef.current = onSelectionChange;

  const clearHighlights = useCallback(() => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }

    const editor = editorRef.current;
    if (!editor || highlightDecorationIdsRef.current.length === 0) return;

    highlightDecorationIdsRef.current = editor.deltaDecorations(
      highlightDecorationIdsRef.current,
      []
    );
  }, [editorRef]);

  const clearSymbolHighlights = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || symbolDecorationIdsRef.current.length === 0) return;

    symbolDecorationIdsRef.current = editor.deltaDecorations(
      symbolDecorationIdsRef.current,
      []
    );
  }, [editorRef]);

  const applyHighlight = useCallback(
    (
      editor: monaco.editor.IStandaloneCodeEditor,
      selection: FileSelectionRange,
      source: "navigation" | "ai"
    ) => {
      clearHighlights();

      const lineClassName =
        source === "ai"
          ? "editor-ai-highlight-line"
          : "editor-navigation-highlight-line";
      const inlineClassName =
        source === "ai"
          ? "editor-ai-highlight-range"
          : "editor-navigation-highlight-range";
      const overviewColor = source === "ai" ? "#34c75955" : "#ff950055";

      highlightDecorationIdsRef.current = editor.deltaDecorations([], [
        {
          range: new monaco.Range(selection.startLine, 1, selection.endLine, 1),
          options: {
            isWholeLine: true,
            className: lineClassName,
            overviewRuler: {
              color: overviewColor,
              position: monaco.editor.OverviewRulerLane.Full,
            },
          },
        },
        {
          range: createHighlightRange(selection),
          options: {
            inlineClassName,
          },
        },
      ]);

      highlightTimerRef.current = window.setTimeout(() => {
        const activeEditor = editorRef.current;
        if (activeEditor && highlightDecorationIdsRef.current.length > 0) {
          highlightDecorationIdsRef.current = activeEditor.deltaDecorations(
            highlightDecorationIdsRef.current,
            []
          );
        }
        highlightTimerRef.current = null;
      }, source === "ai" ? 2600 : 1800);
    },
    [clearHighlights, editorRef]
  );

  const updateSymbolHighlights = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      const model = editor.getModel();
      if (!model) {
        clearSymbolHighlights();
        return;
      }

      const selection = editor.getSelection();
      let targetText = "";
      let activeRange: monaco.Range | null = null;

      if (
        selection &&
        !selection.isEmpty() &&
        selection.startLineNumber === selection.endLineNumber
      ) {
        const selectedText = model.getValueInRange(selection);
        if (selectedText.length <= 64 && isIdentifierLike(selectedText)) {
          targetText = selectedText;
          activeRange = new monaco.Range(
            selection.startLineNumber,
            selection.startColumn,
            selection.endLineNumber,
            selection.endColumn
          );
        }
      }

      if (!targetText) {
        const position = editor.getPosition();
        if (!position) {
          clearSymbolHighlights();
          return;
        }

        const word = model.getWordAtPosition(position);
        if (!word || word.word.length < 2 || !isIdentifierLike(word.word)) {
          clearSymbolHighlights();
          return;
        }

        targetText = word.word;
        activeRange = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn
        );
      }

      const rawMatches = model.findMatches(
        targetText,
        false,
        false,
        true,
        null,
        false,
        250
      );
      const matches = rawMatches.filter((match) => {
        const wordAtPosition = model.getWordAtPosition({
          lineNumber: match.range.startLineNumber,
          column: match.range.startColumn,
        });

        return (
          wordAtPosition?.word === targetText &&
          wordAtPosition.startColumn === match.range.startColumn &&
          wordAtPosition.endColumn === match.range.endColumn
        );
      });

      if (matches.length <= 1 || !activeRange) {
        clearSymbolHighlights();
        return;
      }

      symbolDecorationIdsRef.current = editor.deltaDecorations(
        symbolDecorationIdsRef.current,
        matches.map((match) => ({
          range: match.range,
          options: rangesMatch(match.range, activeRange)
            ? {
                inlineClassName: "editor-symbol-highlight-current",
                overviewRuler: {
                  color: "#007aff44",
                  position: monaco.editor.OverviewRulerLane.Center,
                },
              }
            : {
                inlineClassName: "editor-symbol-highlight",
              },
        }))
      );
    },
    [clearSymbolHighlights]
  );

  const navigateToDefinition = useCallback(
    async (
      editor: monaco.editor.IStandaloneCodeEditor,
      symbol: string,
      position: monaco.Position
    ) => {
      let location = findDefinitionLocation(symbol, path, position, openFiles);
      if (!location) {
        try {
          location = await onFindDefinition(symbol, path);
        } catch (error) {
          console.warn("Failed to resolve definition:", error);
          return;
        }
      }

      if (!location) return;

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
        applyHighlight(editor, location.selection, "navigation");
        return;
      }

      await onNavigateToLocation(location.path, location.selection);
    },
    [applyHighlight, onFindDefinition, onNavigateToLocation, openFiles, path]
  );

  const navigateToDefinitionRef = useRef(navigateToDefinition);
  navigateToDefinitionRef.current = navigateToDefinition;
  const updateSymbolHighlightsRef = useRef(updateSymbolHighlights);
  updateSymbolHighlightsRef.current = updateSymbolHighlights;

  const handleMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;
      pluginCleanupRef.current?.();

      // Cmd/Ctrl + S to save
      editor.addAction({
        id: "save-file",
        label: t("editor.saveFile"),
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveRef.current(),
      });

      // Track selection changes
      editor.onDidChangeCursorSelection(() => {
        const selection = editor.getSelection();
        if (selection && !selection.isEmpty()) {
          const text = editor.getModel()?.getValueInRange(selection) || "";
          if (text.trim()) {
            onSelectionChangeRef.current({
              text,
              startLine: selection.startLineNumber,
              endLine: selection.endLineNumber,
            });
            return;
          }
        }
        onSelectionChangeRef.current(null);
        updateSymbolHighlightsRef.current(editor);
      });

      editor.onDidChangeModelContent(() => {
        updateSymbolHighlightsRef.current(editor);
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

        browserEvent.preventDefault();
        browserEvent.stopPropagation();
        void navigateToDefinitionRef.current(
          editor,
          word.word,
          event.target.position
        );
      });

      editor.onDidBlurEditorText(() => {
        clearSymbolHighlights();
      });

      editor.onDidFocusEditorText(() => {
        updateSymbolHighlightsRef.current(editor);
      });

      editor.focus();
      updateSymbolHighlightsRef.current(editor);
      pluginCleanupRef.current = runEditorMountHandlers({
        editor,
        monaco,
        path,
        language,
      });
    },
    [
      clearSymbolHighlights,
      editorRef,
      language,
      path,
      t,
    ]
  );

  useEffect(
    () => () => {
      pluginCleanupRef.current?.();
      pluginCleanupRef.current = null;
      clearHighlights();
      clearSymbolHighlights();
    },
    [clearHighlights, clearSymbolHighlights]
  );

  useEffect(() => {
    monaco.editor.setTheme(getEditorThemeName(theme));
  }, [theme]);

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
    applyHighlight(editor, navigationTarget, "navigation");
    onNavigationComplete(navigationTarget.requestId);
  }, [applyHighlight, editorRef, navigationTarget, onNavigationComplete, path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !highlightTarget || highlightTarget.path !== path) return;

    applyHighlight(editor, highlightTarget, "ai");
    onHighlightComplete(highlightTarget.requestId);
  }, [applyHighlight, editorRef, highlightTarget, onHighlightComplete, path]);

  return (
    <div className="editor-container">
      <MonacoEditor
        key={`${path}:${locale}`}
        height="100%"
        language={language}
        path={path}
        value={content}
        onChange={(val) => onChange(val ?? "")}
        onMount={handleMount}
        theme={getEditorThemeName(theme)}
        options={{
          "semanticHighlighting.enabled": true,
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
          selectionHighlight: false,
          occurrencesHighlight: "off",
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
