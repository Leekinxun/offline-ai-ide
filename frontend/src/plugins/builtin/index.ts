import type { BuiltinPluginDefinition } from "../types";
import { localizationPlugin } from "./localizationPlugin";
import { markdownRendererPlugin } from "./markdownRendererPlugin";
import { monacoHighlighterPlugin } from "./monacoHighlighterPlugin";

export const builtinPlugins: BuiltinPluginDefinition[] = [
  localizationPlugin,
  monacoHighlighterPlugin,
  markdownRendererPlugin,
];
