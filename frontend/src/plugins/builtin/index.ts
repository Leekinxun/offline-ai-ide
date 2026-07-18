import type { BuiltinPluginDefinition } from "../types";
import { localizationPlugin } from "./localizationPlugin";
import { markdownRendererPlugin } from "./markdownRendererPlugin";
import { jsonPreviewPlugin } from "./jsonPreviewPlugin";

export const builtinPlugins: BuiltinPluginDefinition[] = [
  localizationPlugin,
  markdownRendererPlugin,
  jsonPreviewPlugin,
];
