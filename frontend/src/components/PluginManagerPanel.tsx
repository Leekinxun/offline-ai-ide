import React, { useMemo, useState } from "react";
import {
  ChevronRight,
  RotateCcw,
  Package,
  PlugZap,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { usePlugins } from "../hooks/usePlugins";
import { useI18n } from "../i18n";
import { runRegisteredPluginCommand } from "../plugins/runtime";
import type { PluginManagerEntry } from "../hooks/usePlugins";

interface PluginManagerPanelProps {
  visible: boolean;
  token: string;
  isAdmin: boolean;
  onShowToast: (message: string) => void;
}

function statusLabel(
  status: PluginManagerEntry["status"],
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  switch (status) {
    case "loaded":
      return t("plugin.loaded");
    case "failed":
      return t("plugin.failed");
    case "disabled":
      return t("plugin.disabled");
    case "detected":
      return t("plugin.detected");
    default:
      return status;
  }
}

interface PluginRowProps {
  plugin: PluginManagerEntry;
  isAdmin: boolean;
  isSaving: boolean;
  onToggle: (plugin: PluginManagerEntry) => void;
  onRestoreDefault: (plugin: PluginManagerEntry) => void;
  onRunCommand: (commandId: string, title: string) => void;
  runningCommandId: string | null;
}

function PluginRow({
  plugin,
  isAdmin,
  isSaving,
  onToggle,
  onRestoreDefault,
  onRunCommand,
  runningCommandId,
}: PluginRowProps) {
  const { t } = useI18n();
  const showReloadHint = plugin.status === "detected" || plugin.requiresReload;
  const canToggle = isAdmin;

  return (
    <div className="settings-plugin-row">
      <div className="settings-plugin-header">
        <div className="settings-plugin-title-wrap">
          <div className="settings-plugin-name">{plugin.manifest.name}</div>
          <div className="settings-plugin-badges">
            <span className={`settings-status-badge ${plugin.status}`}>
              {statusLabel(plugin.status, t)}
            </span>
            <span className="settings-status-badge neutral">
              {plugin.manifest.kind === "builtin"
                ? t("plugin.builtin")
                : t("plugin.external")}
            </span>
            <span className="settings-status-badge neutral">
              {plugin.manifest.defaultEnabled
                ? t("plugin.defaultOn")
                : t("plugin.defaultOff")}
            </span>
            {plugin.isOverridden && (
              <span className="settings-status-badge overridden">
                {t("plugin.overridden")}
              </span>
            )}
            <span
              className={`settings-status-badge ${plugin.manifest.enabled ? "enabled" : "disabled-state"}`}
            >
              {plugin.manifest.enabled ? t("plugin.enabled") : t("plugin.disabled")}
            </span>
          </div>
        </div>
        <div className="settings-plugin-side">
          <div className="settings-plugin-version">v{plugin.manifest.version}</div>
          <div className="settings-plugin-actions">
            <button
              className={`settings-inline-btn settings-plugin-toggle${plugin.manifest.enabled ? " enabled" : ""}`}
              onClick={() => onToggle(plugin)}
              disabled={!canToggle || isSaving}
              title={
                canToggle
                  ? plugin.manifest.enabled
                    ? t("plugin.disablePlugin")
                    : t("plugin.enablePlugin")
                  : t("plugin.adminAccessRequired")
              }
            >
              {plugin.manifest.enabled ? <ToggleRight size={15} /> : <ToggleLeft size={15} />}
              {isSaving
                ? t("plugin.saving")
                : plugin.manifest.enabled
                ? t("plugin.disable")
                : t("plugin.enable")}
            </button>
            {plugin.isOverridden && (
              <button
                className="settings-inline-btn settings-plugin-restore"
                onClick={() => onRestoreDefault(plugin)}
                disabled={!canToggle || isSaving}
                title={
                  canToggle
                    ? t("plugin.restorePluginDefault")
                    : t("plugin.adminAccessRequired")
                }
              >
                <RotateCcw size={13} />
                {t("common.default")}
              </button>
            )}
          </div>
        </div>
      </div>

      {plugin.manifest.description && (
        <div className="settings-plugin-description">{plugin.manifest.description}</div>
      )}

      <div className="settings-plugin-meta">
        <span>{t("plugin.id")}: {plugin.manifest.id}</span>
        <span>
          {t("plugin.scopes")}: {plugin.manifest.scopes.join(", ") || t("common.none")}
        </span>
        <span>
          {t("plugin.permissions")}: {plugin.manifest.permissions.join(", ") || t("common.none")}
        </span>
        {plugin.manifest.entry && <span>{t("plugin.entry")}: {plugin.manifest.entry}</span>}
        {plugin.manifest.directoryPath && (
          <span>{t("plugin.directory")}: {plugin.manifest.directoryPath}</span>
        )}
        {plugin.manifest.author && <span>{t("plugin.author")}: {plugin.manifest.author}</span>}
      </div>

      {plugin.commands.length > 0 && (
        <div className="settings-plugin-commands">
          <div className="settings-plugin-commands-title">
            {t("plugin.registeredCommands")}
          </div>
          <div className="settings-plugin-command-list">
            {plugin.commands.map((command) => (
              <div key={command.id} className="settings-plugin-command-row">
                <div className="settings-plugin-command-info">
                  <span className="settings-plugin-command-title">
                    {command.title}
                  </span>
                  <span className="settings-plugin-command-id">{command.id}</span>
                  {command.description && (
                    <span className="settings-plugin-command-description">
                      {command.description}
                    </span>
                  )}
                </div>
                <button
                  className="settings-inline-btn settings-plugin-command-run"
                  onClick={() => onRunCommand(command.id, command.title)}
                  disabled={runningCommandId === command.id}
                >
                  <ChevronRight size={13} />
                  {runningCommandId === command.id ? t("plugin.running") : t("common.run")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(plugin.error || showReloadHint) && (
        <div
          className={`settings-plugin-message${plugin.error ? " error" : ""}`}
        >
          {plugin.error || t("plugin.reloadHint")}
        </div>
      )}
    </div>
  );
}

export const PluginManagerPanel: React.FC<PluginManagerPanelProps> = ({
  visible,
  token,
  isAdmin,
  onShowToast,
}) => {
  const { t } = useI18n();
  const [runningCommandId, setRunningCommandId] = useState<string | null>(null);
  const {
    plugins,
    pluginsDir,
    loading,
    savingPluginId,
    error,
    refresh,
    setPluginEnabled,
    clearPluginOverride,
    summary,
  } = usePlugins(visible, token, isAdmin);

  const builtinPlugins = useMemo(
    () => plugins.filter((plugin) => plugin.manifest.kind === "builtin"),
    [plugins]
  );
  const externalPlugins = useMemo(
    () => plugins.filter((plugin) => plugin.manifest.kind === "external"),
    [plugins]
  );

  const handleToggle = async (plugin: PluginManagerEntry) => {
    try {
      await setPluginEnabled(plugin.manifest.id, !plugin.manifest.enabled);
      onShowToast(
        plugin.manifest.enabled
          ? t("plugin.disabledToast", { name: plugin.manifest.name })
          : t("plugin.enabledToast", { name: plugin.manifest.name })
      );
    } catch (nextError) {
      onShowToast(
        nextError instanceof Error ? nextError.message : t("plugin.failedToUpdate")
      );
    }
  };

  const handleRestoreDefault = async (plugin: PluginManagerEntry) => {
    try {
      await clearPluginOverride(plugin.manifest.id);
      onShowToast(t("plugin.restoreToast", { name: plugin.manifest.name }));
    } catch (nextError) {
      onShowToast(
        nextError instanceof Error
          ? nextError.message
          : t("plugin.failedToRestoreDefault")
      );
    }
  };

  const handleRunCommand = async (commandId: string, title: string) => {
    setRunningCommandId(commandId);
    try {
      await runRegisteredPluginCommand(commandId);
      onShowToast(t("plugin.commandExecuted", { title }));
    } catch (nextError) {
      onShowToast(
        nextError instanceof Error
          ? nextError.message
          : t("plugin.failedToRunCommand", { title })
      );
    } finally {
      setRunningCommandId(null);
    }
  };

  return (
    <section className="settings-card settings-card-full">
      <div className="settings-card-header">
        <div className="settings-card-title">
          <PlugZap size={16} />
          <span>{t("plugin.management")}</span>
        </div>
        <span className="settings-card-meta">
          {t("plugin.managementMeta")}
        </span>
      </div>

      {!isAdmin && (
        <div className="settings-plugin-message">
          {t("plugin.readOnly")}
        </div>
      )}

      <div className="settings-plugin-toolbar">
        <div className="settings-plugin-summary">
          <span className="settings-plugin-summary-chip">
            {t("plugin.totalCount", { count: summary.total })}
          </span>
          <span className="settings-plugin-summary-chip success">
            {t("plugin.loadedCount", { count: summary.loaded })}
          </span>
          <span className="settings-plugin-summary-chip danger">
            {t("plugin.failedCount", { count: summary.failed })}
          </span>
          <span className="settings-plugin-summary-chip warning">
            {t("plugin.disabledCount", { count: summary.disabled })}
          </span>
          <span className="settings-plugin-summary-chip neutral">
            {t("plugin.detectedCount", { count: summary.detected })}
          </span>
        </div>

        <div className="settings-plugin-toolbar-actions">
          <button
            className="settings-inline-btn"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={14} />
            {loading ? t("plugin.refreshing") : t("plugin.refreshList")}
          </button>
          <button
            className="settings-inline-btn"
            onClick={() => window.location.reload()}
          >
            <RotateCcw size={14} />
            {t("plugin.reloadApp")}
          </button>
        </div>
      </div>

      <div className="settings-plugin-install-hint">
        <Package size={15} />
        <span>
          {t("plugin.offlineInstallDirectory")}
          <code>{pluginsDir || "plugins/"}</code>
        </span>
      </div>

      {error && <div className="settings-error-banner" style={{ margin: 0 }}>{error}</div>}

      {plugins.length === 0 && !loading ? (
        <div className="settings-plugin-empty">
          {t("plugin.noPlugins")}
        </div>
      ) : (
        <div className="settings-plugin-sections">
          <div className="settings-plugin-section">
            <div className="settings-plugin-section-title">
              {t("plugin.builtinPlugins")}
            </div>
            {builtinPlugins.length > 0 ? (
              <div className="settings-plugin-list">
                {builtinPlugins.map((plugin) => (
                  <PluginRow
                    key={plugin.manifest.id}
                    plugin={plugin}
                    isAdmin={isAdmin}
                    isSaving={savingPluginId === plugin.manifest.id}
                    onToggle={handleToggle}
                    onRestoreDefault={handleRestoreDefault}
                    onRunCommand={handleRunCommand}
                    runningCommandId={runningCommandId}
                  />
                ))}
              </div>
            ) : (
              <div className="settings-plugin-empty subtle">
                {t("plugin.noBuiltin")}
              </div>
            )}
          </div>

          <div className="settings-plugin-section">
            <div className="settings-plugin-section-title">
              {t("plugin.externalPlugins")}
            </div>
            {externalPlugins.length > 0 ? (
              <div className="settings-plugin-list">
                {externalPlugins.map((plugin) => (
                  <PluginRow
                    key={plugin.manifest.id}
                    plugin={plugin}
                    isAdmin={isAdmin}
                    isSaving={savingPluginId === plugin.manifest.id}
                    onToggle={handleToggle}
                    onRestoreDefault={handleRestoreDefault}
                    onRunCommand={handleRunCommand}
                    runningCommandId={runningCommandId}
                  />
                ))}
              </div>
            ) : (
              <div className="settings-plugin-empty subtle">
                {t("plugin.noExternal")}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
