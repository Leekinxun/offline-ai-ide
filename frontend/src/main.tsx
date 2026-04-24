import React from "react";
import ReactDOM from "react-dom/client";
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { registerEditorTheme } from "./editor/theme";
import { registerComponentLanguages } from "./editor/componentLanguages";
import { registerSemanticTokensProviders } from "./editor/semanticTokens";

// Configure Monaco to use local bundle (offline support)
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// @ts-ignore
self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new cssWorker();
    if (
      label === "html" ||
      label === "handlebars" ||
      label === "razor" ||
      label === "vue" ||
      label === "svelte"
    )
      return new htmlWorker();
    if (label === "typescript" || label === "javascript")
      return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
registerEditorTheme();
registerComponentLanguages();
registerSemanticTokensProviders();

// Import app
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
