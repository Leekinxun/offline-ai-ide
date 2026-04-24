import {
  registerComponentLanguages,
} from "../../editor/componentLanguages";
import { registerSemanticTokensProviders } from "../../editor/semanticTokens";
import { registerEditorTheme } from "../../editor/theme";
import { derivePluginScopes } from "../permissions";
import type { BuiltinPluginDefinition } from "../types";

const permissions = ["editor.setup"] as const;

export const monacoHighlighterPlugin: BuiltinPluginDefinition = {
  manifest: {
    id: "builtin.monaco-highlighting",
    name: "Monaco Highlighting",
    version: "1.0.0",
    kind: "builtin",
    defaultEnabled: true,
    enabled: true,
    permissions: [...permissions],
    scopes: derivePluginScopes([...permissions]),
    loadable: true,
    description:
      "Registers Monaco theme, component languages, and semantic token providers.",
  },
  activate(context) {
    context.editor.registerSetup(() => {
      registerEditorTheme();
      registerComponentLanguages();
      registerSemanticTokensProviders();
    });
  },
};
