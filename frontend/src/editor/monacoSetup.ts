import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Monaco is only initialized when the editor chunk is requested. This keeps the
// login and empty-workspace paths lightweight while preserving offline workers.
// @ts-ignore
self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (["html", "handlebars", "razor", "vue", "svelte"].includes(label)) {
      return new htmlWorker();
    }
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

const sharedCompilerOptions: monaco.languages.typescript.CompilerOptions = {
  allowJs: true,
  allowNonTsExtensions: true,
  checkJs: true,
  noEmit: true,
  target: monaco.languages.typescript.ScriptTarget.ES2020,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
};

const diagnosticsOptions: monaco.languages.typescript.DiagnosticsOptions = {
  noSemanticValidation: false,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: false,
  onlyVisible: false,
  // Monaco does not own the whole workspace module graph. Avoid presenting
  // unresolved imports as errors while preserving syntax and unknown-name checks.
  diagnosticCodesToIgnore: [2307],
};

monaco.languages.typescript.javascriptDefaults.setCompilerOptions(sharedCompilerOptions);
monaco.languages.typescript.typescriptDefaults.setCompilerOptions(sharedCompilerOptions);
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
