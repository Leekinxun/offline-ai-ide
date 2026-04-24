import { derivePluginScopes } from "../permissions";
import type { BuiltinPluginDefinition } from "../types";
import { LOCALIZATION_PLUGIN_BUNDLES } from "../../i18n/messages";

const permissions = ["ui.messages"] as const;

export const localizationPlugin: BuiltinPluginDefinition = {
  manifest: {
    id: "builtin.ui-localization",
    name: "UI Localization",
    version: "1.0.0",
    kind: "builtin",
    defaultEnabled: true,
    enabled: true,
    permissions: [...permissions],
    scopes: derivePluginScopes([...permissions]),
    loadable: true,
    description: "Registers English and Simplified Chinese interface message bundles.",
  },
  activate(context) {
    for (const bundle of LOCALIZATION_PLUGIN_BUNDLES) {
      context.ui.registerLocaleBundle(bundle);
    }
  },
};
