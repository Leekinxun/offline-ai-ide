import React from "react";
import * as monaco from "monaco-editor";
import type { PluginPermission } from "./permissions";
import type {
  BuiltinPluginDefinition,
  ChatTextRenderer,
  EditorMountContext,
  EditorMountHandler,
  EditorSetupHandler,
  ExternalPluginManifest,
  LocaleBundle,
  LocaleMessageDictionary,
  PluginActivationContext,
  PluginCommandDefinition,
  PluginLoadState,
  PluginLogger,
  RegisteredPluginCommand,
  PluginStateOverride,
  RuntimePluginManifest,
} from "./types";
import type { ChatMessage } from "../types";
import { builtinPlugins } from "./builtin";

interface ExternalPluginsResponse {
  plugins?: ExternalPluginManifest[];
  pluginsDir?: string;
  overrides?: Record<string, PluginStateOverride>;
}

interface RegisteredChatTextRenderer extends ChatTextRenderer {
  pluginId: string;
}

interface RegisteredEditorMountHandler {
  pluginId: string;
  handler: EditorMountHandler;
}

const chatTextRenderers: RegisteredChatTextRenderer[] = [];
const editorMountHandlers: RegisteredEditorMountHandler[] = [];
const registeredPluginCommands: RegisteredPluginCommand[] = [];
const pluginLoadStates: PluginLoadState[] = [];
const localeBundles = new Map<string, LocaleBundle>();
const stateListeners = new Set<(states: PluginLoadState[]) => void>();
let initializationPromise: Promise<PluginLoadState[]> | null = null;

function createPluginLogger(pluginId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}]`;
  return {
    debug: (...args) => console.debug(prefix, ...args),
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}

function registerChatTextRenderer(
  pluginId: string,
  renderer: ChatTextRenderer
): void {
  chatTextRenderers.push({ ...renderer, pluginId });
  chatTextRenderers.sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      left.pluginId.localeCompare(right.pluginId) ||
      left.id.localeCompare(right.id)
  );
}

function registerEditorSetup(pluginId: string, setup: EditorSetupHandler): void {
  try {
    setup({ monaco });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : `Editor setup failed for plugin ${pluginId}`
    );
  }
}

function registerEditorMountHandler(
  pluginId: string,
  handler: EditorMountHandler
): void {
  editorMountHandlers.push({ pluginId, handler });
}

function ensurePermission(
  manifest: RuntimePluginManifest,
  permission: PluginPermission
): void {
  if (manifest.permissions.includes(permission)) {
    return;
  }

  throw new Error(
    `Permission "${permission}" is required but was not declared by plugin "${manifest.id}"`
  );
}

function registerPluginCommand(
  manifest: RuntimePluginManifest,
  command: PluginCommandDefinition
): void {
  if (!command.id.trim() || !command.title.trim()) {
    throw new Error("Plugin commands require a non-empty id and title");
  }

  if (registeredPluginCommands.some((item) => item.id === command.id)) {
    throw new Error(`Plugin command id "${command.id}" is already registered`);
  }

  registeredPluginCommands.push({
    ...command,
    id: command.id.trim(),
    title: command.title.trim(),
    description: command.description?.trim(),
    pluginId: manifest.id,
    pluginName: manifest.name,
  });
}

function normalizeLocaleMessages(messages: LocaleMessageDictionary): LocaleMessageDictionary {
  const normalizedEntries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(messages)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      throw new Error("Locale bundle message keys must be non-empty strings");
    }

    if (typeof value !== "string") {
      throw new Error(`Locale bundle message "${trimmedKey}" must be a string`);
    }

    normalizedEntries.push([trimmedKey, value]);
  }

  return Object.fromEntries(normalizedEntries);
}

function registerLocaleBundle(
  manifest: RuntimePluginManifest,
  bundle: LocaleBundle
): void {
  const locale = bundle.locale.trim();
  const label = bundle.label.trim();

  if (!locale || !label) {
    throw new Error("Locale bundles require a non-empty locale and label");
  }

  if (!bundle.messages || typeof bundle.messages !== "object") {
    throw new Error("Locale bundles require a messages object");
  }

  const existing = localeBundles.get(locale);
  localeBundles.set(locale, {
    locale,
    label,
    messages: {
      ...(existing?.messages ?? {}),
      ...normalizeLocaleMessages(bundle.messages),
    },
  });
}

function applyPluginOverride(
  manifest: RuntimePluginManifest,
  overrides: Record<string, PluginStateOverride>
): RuntimePluginManifest {
  const override = overrides[manifest.id];
  if (typeof override?.enabled !== "boolean") {
    return manifest;
  }

  return {
    ...manifest,
    enabled: override.enabled,
  };
}

function createActivationContext(
  manifest: RuntimePluginManifest
): PluginActivationContext {
  const logger = createPluginLogger(manifest.id);

  return {
    React,
    monaco,
    plugin: {
      id: manifest.id,
      permissions: [...manifest.permissions],
      scopes: [...manifest.scopes],
    },
    chat: {
      registerTextRenderer(renderer) {
        ensurePermission(manifest, "chat.render");
        registerChatTextRenderer(manifest.id, renderer);
      },
    },
    editor: {
      registerSetup(setup) {
        ensurePermission(manifest, "editor.setup");
        registerEditorSetup(manifest.id, setup);
      },
      registerMountHandler(handler) {
        ensurePermission(manifest, "editor.mount");
        registerEditorMountHandler(manifest.id, handler);
      },
    },
    commands: {
      registerCommand(command) {
        ensurePermission(manifest, "command.register");
        registerPluginCommand(manifest, command);
      },
    },
    ui: {
      registerLocaleBundle(bundle) {
        ensurePermission(manifest, "ui.messages");
        registerLocaleBundle(manifest, bundle);
      },
    },
    logger,
  };
}

async function activatePlugin(
  manifest: RuntimePluginManifest,
  activate: BuiltinPluginDefinition["activate"]
): Promise<void> {
  await activate(createActivationContext(manifest));
}

function resolveEntrypoint(moduleValue: unknown): BuiltinPluginDefinition["activate"] | null {
  if (typeof moduleValue === "function") {
    return moduleValue as BuiltinPluginDefinition["activate"];
  }

  if (moduleValue && typeof moduleValue === "object") {
    const candidate = moduleValue as { activate?: unknown };
    if (typeof candidate.activate === "function") {
      return candidate.activate as BuiltinPluginDefinition["activate"];
    }
  }

  return null;
}

function trackPluginLoad(
  manifest: RuntimePluginManifest,
  status: PluginLoadState["status"],
  error?: string
): void {
  const nextState = { manifest, status, error };
  const index = pluginLoadStates.findIndex((item) => item.manifest.id === manifest.id);

  if (index >= 0) {
    pluginLoadStates[index] = nextState;
  } else {
    pluginLoadStates.push(nextState);
  }

  for (const listener of stateListeners) {
    listener(getPluginLoadStates());
  }
}

async function loadBuiltinPlugins(): Promise<void> {
  for (const plugin of builtinPlugins) {
    const manifest = applyPluginOverride(plugin.manifest, registry.overrides);

    if (!manifest.enabled) {
      trackPluginLoad(manifest, "disabled");
      continue;
    }

    try {
      await activatePlugin(manifest, plugin.activate);
      trackPluginLoad(manifest, "loaded");
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown builtin plugin error";
      trackPluginLoad(manifest, "failed", detail);
      console.error(`[plugin:${manifest.id}]`, error);
    }
  }
}

interface PluginRegistrySnapshot {
  plugins: ExternalPluginManifest[];
  overrides: Record<string, PluginStateOverride>;
}

async function fetchPluginRegistry(): Promise<PluginRegistrySnapshot> {
  try {
    const response = await fetch("/api/plugins", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load plugins: ${response.status}`);
    }

    const payload = (await response.json()) as ExternalPluginsResponse;
    return {
      plugins: Array.isArray(payload.plugins) ? payload.plugins : [],
      overrides:
        payload.overrides && typeof payload.overrides === "object"
          ? payload.overrides
          : {},
    };
  } catch (error) {
    console.error("[plugin-runtime] Failed to fetch external plugins:", error);
    return {
      plugins: [],
      overrides: {},
    };
  }
}

let registry: PluginRegistrySnapshot = {
  plugins: [],
  overrides: {},
};

async function loadExternalPlugins(): Promise<void> {
  const manifests = registry.plugins;

  for (const manifest of manifests) {
    if (!manifest.enabled) {
      trackPluginLoad(manifest, "disabled");
      continue;
    }

    if (!manifest.loadable || !manifest.entryUrl) {
      trackPluginLoad(
        manifest,
        "failed",
        manifest.validationError || "Plugin entry is not loadable"
      );
      continue;
    }

    try {
      const moduleValue = await import(/* @vite-ignore */ manifest.entryUrl);
      const activate = resolveEntrypoint(
        (moduleValue as Record<string, unknown>).default ?? moduleValue
      );

      if (!activate) {
        throw new Error("Plugin entry must export a default function or activate()");
      }

      await activatePlugin(manifest, activate);
      trackPluginLoad(manifest, "loaded");
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown external plugin error";
      trackPluginLoad(manifest, "failed", detail);
      console.error(`[plugin:${manifest.id}]`, error);
    }
  }
}

async function initialize(): Promise<PluginLoadState[]> {
  registry = await fetchPluginRegistry();
  await loadBuiltinPlugins();
  await loadExternalPlugins();
  return pluginLoadStates;
}

export function initializePluginRuntime(): Promise<PluginLoadState[]> {
  if (!initializationPromise) {
    initializationPromise = initialize();
  }
  return initializationPromise;
}

export function getPluginLoadStates(): PluginLoadState[] {
  return [...pluginLoadStates];
}

export function getRegisteredPluginCommands(): RegisteredPluginCommand[] {
  return [...registeredPluginCommands].sort(
    (left, right) =>
      left.pluginName.localeCompare(right.pluginName) ||
      left.title.localeCompare(right.title)
  );
}

export function getRegisteredLocaleBundles(): LocaleBundle[] {
  return Array.from(localeBundles.values()).sort((left, right) =>
    left.locale.localeCompare(right.locale)
  );
}

export async function runRegisteredPluginCommand(commandId: string): Promise<void> {
  const command = registeredPluginCommands.find((item) => item.id === commandId);
  if (!command) {
    throw new Error(`Plugin command "${commandId}" was not found`);
  }

  await command.run();
}

export function subscribePluginLoadStates(
  listener: (states: PluginLoadState[]) => void
): () => void {
  stateListeners.add(listener);
  listener(getPluginLoadStates());

  return () => {
    stateListeners.delete(listener);
  };
}

export function renderChatTextPart(
  content: string,
  message: ChatMessage
): React.ReactNode {
  for (const renderer of chatTextRenderers) {
    try {
      const rendered = renderer.render({ content, message, React });
      if (rendered !== null) {
        return rendered;
      }
    } catch (error) {
      console.error(
        `[plugin:${renderer.pluginId}] chat text renderer "${renderer.id}" failed`,
        error
      );
    }
  }

  return React.createElement("div", { className: "chat-markdown" }, content);
}

export function runEditorMountHandlers(
  context: EditorMountContext
): () => void {
  const disposers: Array<() => void> = [];

  for (const contribution of editorMountHandlers) {
    try {
      const dispose = contribution.handler(context);
      if (typeof dispose === "function") {
        disposers.push(dispose);
      }
    } catch (error) {
      console.error(
        `[plugin:${contribution.pluginId}] editor mount handler failed`,
        error
      );
    }
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        console.error("[plugin-runtime] Failed to clean up editor handler", error);
      }
    }
  };
}
