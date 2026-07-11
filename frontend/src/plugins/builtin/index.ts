import type { BuiltinPluginDefinition } from "../types";
import { localizationPlugin } from "./localizationPlugin";
import { markdownRendererPlugin } from "./markdownRendererPlugin";

export const builtinPlugins: BuiltinPluginDefinition[] = [
  localizationPlugin,
  markdownRendererPlugin,
];
