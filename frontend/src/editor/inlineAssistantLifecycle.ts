import type * as monaco from "monaco-editor";

export function isInlineAssistantEditorUsable(
  editor: monaco.editor.IStandaloneCodeEditor | null
): editor is monaco.editor.IStandaloneCodeEditor {
  if (!editor) return false;
  try {
    const model = editor.getModel();
    return Boolean(model && !model.isDisposed());
  } catch {
    return false;
  }
}

export function isDisposedInlineAssistantContextError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  return /AbstractContextKeyService has been disposed/i.test(reason.message);
}
