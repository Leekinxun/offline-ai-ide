import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getRegisteredPluginCommands,
  getPluginLoadStates,
  subscribePluginLoadStates,
} from "../plugins/runtime";
import type {
  ExternalPluginManifest,
  PluginLoadState,
  RegisteredPluginCommand,
  PluginStateOverride,
  RuntimePluginManifest,
} from "../plugins/types";

interface PluginRegistryResponse {
  plugins?: ExternalPluginManifest[];
  pluginsDir?: string;
  overrides?: Record<string, PluginStateOverride>;
}

export interface PluginManagerEntry {
  manifest: RuntimePluginManifest;
  status: PluginLoadState["status"] | "detected";
  error?: string;
  commands: RegisteredPluginCommand[];
  isOverridden: boolean;
  requiresReload?: boolean;
}

function sortPlugins(entries: PluginManagerEntry[]): PluginManagerEntry[] {
  return [...entries].sort((left, right) => {
    if (left.manifest.kind !== right.manifest.kind) {
      return left.manifest.kind === "builtin" ? -1 : 1;
    }

    if (left.status !== right.status) {
      const order = ["failed", "disabled", "detected", "loaded"];
      return order.indexOf(left.status) - order.indexOf(right.status);
    }

    return left.manifest.name.localeCompare(right.manifest.name);
  });
}

export function usePlugins(visible: boolean, token: string, isAdmin: boolean) {
  const [loadStates, setLoadStates] = useState<PluginLoadState[]>(
    () => getPluginLoadStates()
  );
  const [registryPlugins, setRegistryPlugins] = useState<ExternalPluginManifest[]>(
    []
  );
  const [pluginOverrides, setPluginOverrides] = useState<
    Record<string, PluginStateOverride>
  >({});
  const [pluginsDir, setPluginsDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingPluginId, setSavingPluginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribePluginLoadStates(setLoadStates), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/plugins", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load plugins: ${response.status}`);
      }

      const payload = (await response.json()) as PluginRegistryResponse;
      setRegistryPlugins(Array.isArray(payload.plugins) ? payload.plugins : []);
      setPluginsDir(payload.pluginsDir || null);
      setPluginOverrides(
        payload.overrides && typeof payload.overrides === "object"
          ? payload.overrides
          : {}
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to load plugins"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [refresh, visible]);

  const plugins = useMemo(() => {
    const merged = new Map<string, PluginManagerEntry>();
    const commandsByPluginId = new Map<string, RegisteredPluginCommand[]>();

    for (const command of getRegisteredPluginCommands()) {
      const commands = commandsByPluginId.get(command.pluginId) || [];
      commands.push(command);
      commandsByPluginId.set(command.pluginId, commands);
    }

    for (const state of loadStates) {
      const isOverridden = Object.prototype.hasOwnProperty.call(
        pluginOverrides,
        state.manifest.id
      );
      const override = pluginOverrides[state.manifest.id];
      const desiredEnabled =
        typeof override?.enabled === "boolean"
          ? override.enabled
          : state.manifest.defaultEnabled;
      const manifest =
        desiredEnabled === state.manifest.enabled
          ? state.manifest
          : { ...state.manifest, enabled: desiredEnabled };

      merged.set(state.manifest.id, {
        manifest,
        status: state.status,
        error: state.error,
        commands: commandsByPluginId.get(state.manifest.id) || [],
        isOverridden,
        requiresReload: desiredEnabled !== state.manifest.enabled,
      });
    }

    for (const manifest of registryPlugins) {
      const isOverridden = Object.prototype.hasOwnProperty.call(
        pluginOverrides,
        manifest.id
      );
      const existing = merged.get(manifest.id);
      if (existing) {
        merged.set(manifest.id, {
          manifest: {
            ...existing.manifest,
            ...manifest,
          },
          status: existing.status,
          error: existing.error || manifest.validationError,
          commands: existing.commands,
          isOverridden,
          requiresReload:
            existing.requiresReload ||
            existing.manifest.enabled !== manifest.enabled,
        });
        continue;
      }

      merged.set(manifest.id, {
        manifest,
        status: manifest.enabled ? "detected" : "disabled",
        error: manifest.validationError,
        commands: commandsByPluginId.get(manifest.id) || [],
        isOverridden,
        requiresReload: manifest.enabled,
      });
    }

    return sortPlugins(Array.from(merged.values()));
  }, [loadStates, pluginOverrides, registryPlugins]);

  const summary = useMemo(() => {
    return plugins.reduce(
      (accumulator, plugin) => {
        accumulator.total += 1;
        accumulator[plugin.status] += 1;
        return accumulator;
      },
      {
        total: 0,
        loaded: 0,
        failed: 0,
        disabled: 0,
        detected: 0,
      }
    );
  }, [plugins]);

  const setPluginEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      if (!isAdmin) {
        throw new Error("Admin access required");
      }

      setSavingPluginId(pluginId);
      setError(null);

      try {
        const response = await fetch(
          `/api/admin/plugins/${encodeURIComponent(pluginId)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ enabled }),
          }
        );

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to update plugin state");
        }

        await refresh();
      } finally {
        setSavingPluginId(null);
      }
    },
    [isAdmin, refresh, token]
  );

  const clearPluginOverride = useCallback(
    async (pluginId: string) => {
      if (!isAdmin) {
        throw new Error("Admin access required");
      }

      setSavingPluginId(pluginId);
      setError(null);

      try {
        const response = await fetch(
          `/api/admin/plugins/${encodeURIComponent(pluginId)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to restore plugin default");
        }

        await refresh();
      } finally {
        setSavingPluginId(null);
      }
    },
    [isAdmin, refresh, token]
  );

  return {
    plugins,
    pluginsDir,
    loading,
    savingPluginId,
    error,
    refresh,
    setPluginEnabled,
    clearPluginOverride,
    summary,
  };
}
