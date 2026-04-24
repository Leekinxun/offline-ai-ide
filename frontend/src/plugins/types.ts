import type React from "react";
import type * as monaco from "monaco-editor";
import type { ChatMessage } from "../types";
import type { PluginPermission, PluginScope } from "./permissions";

export interface PluginStateOverride {
  enabled: boolean;
}

export interface RuntimePluginManifest {
  id: string;
  name: string;
  version: string;
  kind: "builtin" | "external";
  defaultEnabled: boolean;
  enabled: boolean;
  permissions: PluginPermission[];
  scopes: PluginScope[];
  loadable?: boolean;
  description?: string;
  author?: string;
  entry?: string;
  entryUrl?: string;
  assetBaseUrl?: string;
  directoryName?: string;
  directoryPath?: string;
  validationError?: string;
}

export interface ExternalPluginManifest extends RuntimePluginManifest {
  kind: "external";
  entry?: string;
  entryUrl?: string;
  assetBaseUrl?: string;
}

export interface PluginLoadState {
  manifest: RuntimePluginManifest;
  status: "loaded" | "failed" | "disabled";
  error?: string;
}

export interface PluginCommandDefinition {
  id: string;
  title: string;
  description?: string;
  run: () => void | Promise<void>;
}

export interface RegisteredPluginCommand extends PluginCommandDefinition {
  pluginId: string;
  pluginName: string;
}

export interface ChatTextRenderContext {
  content: string;
  message: ChatMessage;
  React: typeof React;
}

export interface ChatTextRenderer {
  id: string;
  priority?: number;
  render: (context: ChatTextRenderContext) => React.ReactNode | null;
}

export interface EditorSetupContext {
  monaco: typeof monaco;
}

export type EditorSetupHandler = (context: EditorSetupContext) => void;

export interface EditorMountContext {
  editor: monaco.editor.IStandaloneCodeEditor;
  monaco: typeof monaco;
  path: string;
  language: string;
}

export type EditorMountHandler = (
  context: EditorMountContext
) => void | (() => void);

export interface LocaleMessageDictionary {
  [key: string]: string;
}

export interface LocaleBundle {
  locale: string;
  label: string;
  messages: LocaleMessageDictionary;
}

export interface PluginLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface PluginActivationContext {
  React: typeof React;
  monaco: typeof monaco;
  plugin: {
    id: string;
    permissions: PluginPermission[];
    scopes: PluginScope[];
  };
  chat: {
    registerTextRenderer: (renderer: ChatTextRenderer) => void;
  };
  editor: {
    registerSetup: (setup: EditorSetupHandler) => void;
    registerMountHandler: (handler: EditorMountHandler) => void;
  };
  commands: {
    registerCommand: (command: PluginCommandDefinition) => void;
  };
  ui: {
    registerLocaleBundle: (bundle: LocaleBundle) => void;
  };
  logger: PluginLogger;
}

export interface BuiltinPluginDefinition {
  manifest: RuntimePluginManifest;
  activate: (context: PluginActivationContext) => void | Promise<void>;
}
