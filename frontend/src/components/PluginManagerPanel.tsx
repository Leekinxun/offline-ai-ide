import React, { useEffect, useMemo, useState } from "react";
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
import { useExtensionPolicy } from "../hooks/useExtensionPolicy";
import type { PermissionExplanation, RegisteredExtensionPolicyPlugin, TeamRole } from "../types";

const permissionExplanationKey = (permission: string, hookId?: string) => hookId ? `hook:${hookId}:${permission}` : `plugin:${permission}`;

interface PluginManagerPanelProps {
  visible: boolean;
  token: string;
  isAdmin: boolean;
  teamRole?: TeamRole | null;
  readOnly?: boolean;
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
  explanations: Record<string, PermissionExplanation>;
  serverBinding?: RegisteredExtensionPolicyPlugin;
}

function PluginRow({
  plugin,
  isAdmin,
  isSaving,
  onToggle,
  onRestoreDefault,
  onRunCommand,
  runningCommandId,
  explanations,
  serverBinding,
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

      {plugin.manifest.permissions.length > 0 && <div className="plugin-effective-permissions" aria-label={t("plugin.effectivePermissions")}>
        {plugin.manifest.permissions.map((permission) => {
          const explanation = explanations[permissionExplanationKey(permission)];
          return <details key={permission}><summary><span>{permission}</span><span className={`settings-status-badge ${explanation?.allowed ? "enabled" : "disabled-state"}`}>{explanation ? (explanation.allowed ? t("plugin.allowed") : t("plugin.denied")) : t(serverBinding ? "common.loading" : "plugin.serverBindingUnavailable")}</span></summary>{explanation && <div className="plugin-permission-explain">{explanation.layers.map((layer) => <div key={layer.id}><strong>{layer.id}</strong><span>{layer.allowed ? t("plugin.allowed") : t("plugin.denied")} · {layer.reason}</span></div>)}<code>{JSON.stringify(explanation.effectiveSandbox)}</code></div>}</details>;
        })}
      </div>}

      {(serverBinding?.hooks.length || plugin.manifest.hooks?.length) ? <div className="plugin-hook-list"><strong>{t("plugin.hooks")}</strong>{(serverBinding?.hooks || plugin.manifest.hooks || []).map((hook) => <div className="plugin-hook-row" key={hook.id}><span>{hook.id} · {hook.event}</span>{"transport" in hook && hook.transport && <span>{t("plugin.transport")}: {hook.transport.kind}</span>}<span className={`settings-status-badge ${hook.failureMode === "closed" || hook.blocksCompletion ? "danger" : "neutral"}`}>{hook.failureMode === "closed" ? t("plugin.failClosed") : t("plugin.failOpen")}{hook.blocksCompletion ? ` · ${t("plugin.blocksCompletion")}` : ""}</span>{serverBinding && plugin.manifest.permissions.map((permission) => { const explanation = explanations[permissionExplanationKey(permission, hook.id)]; return explanation ? <details className="plugin-hook-policy" key={`${hook.id}:${permission}`}><summary>{permission} · {explanation.allowed ? t("plugin.allowed") : t("plugin.denied")}</summary><div className="plugin-permission-explain">{explanation.layers.map((layer) => <div key={layer.id}><strong>{layer.id}</strong><span>{layer.allowed ? t("plugin.allowed") : t("plugin.denied")} · {layer.reason}</span></div>)}<code>{JSON.stringify(explanation.effectiveSandbox)}</code></div></details> : null; })}</div>)}</div> : null}

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
  teamRole = null,
  readOnly = false,
  onShowToast,
}) => {
  const { t } = useI18n();
  const [runningCommandId, setRunningCommandId] = useState<string | null>(null);
  const [permissionExplanations, setPermissionExplanations] = useState<Record<string, Record<string, PermissionExplanation>>>({});
  const [policyDraft, setPolicyDraft] = useState({ allow: "", deny: "", readPaths: "", writePaths: "", networkOrigins: "", secretEnv: "" });
  const [policySaving, setPolicySaving] = useState(false);
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
  const extensionPolicy = useExtensionPolicy(token, visible);
  const canManageWorkspacePolicy = isAdmin || teamRole === null || teamRole === "owner" || teamRole === "admin";

  useEffect(() => {
    const workspace = extensionPolicy.policy?.workspace;
    if (!workspace) return;
    setPolicyDraft({ allow: workspace.permissions.allow.join("\n"), deny: (workspace.permissions.deny || []).join("\n"), readPaths: (workspace.sandbox.readPaths || []).join("\n"), writePaths: (workspace.sandbox.writePaths || []).join("\n"), networkOrigins: (workspace.sandbox.networkOrigins || []).join("\n"), secretEnv: (workspace.sandbox.secretEnv || []).join("\n") });
  }, [extensionPolicy.policy?.workspace]);

  useEffect(() => {
    if (!extensionPolicy.policy || !plugins.length) return;
    let cancelled = false;
    const registered = new Map(extensionPolicy.policy.plugins.map((plugin) => [plugin.id, plugin]));
    const requests = plugins.flatMap((plugin) => {
      const binding = registered.get(plugin.manifest.id);
      if (!binding) return [];
      const base = plugin.manifest.permissions.map(async (permission) => ({ pluginId: binding.id, key: permissionExplanationKey(permission), explanation: await extensionPolicy.explain(permission, { pluginId: binding.id }) }));
      const hooks = binding.hooks.flatMap((hook) => plugin.manifest.permissions.map(async (permission) => ({ pluginId: binding.id, key: permissionExplanationKey(permission, hook.id), explanation: await extensionPolicy.explain(permission, { pluginId: binding.id, ...(hook.profileId ? { profileId: hook.profileId } : {}), skillIds: hook.skillIds, hookId: hook.id }) })));
      return [...base, ...hooks];
    });
    void Promise.all(requests).then((items) => { if (!cancelled) setPermissionExplanations(items.reduce<Record<string, Record<string, PermissionExplanation>>>((result, item) => ({ ...result, [item.pluginId]: { ...(result[item.pluginId] || {}), [item.key]: item.explanation } }), {})); }).catch((reason) => { if (!cancelled) onShowToast(reason instanceof Error ? reason.message : t("plugin.policyFailed")); });
    return () => { cancelled = true; };
  }, [extensionPolicy.explain, extensionPolicy.policy, onShowToast, plugins, t]);

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

      <div className="settings-plugin-policy-card">
        <div className="settings-plugin-section-title">{t("plugin.effectivePolicy")}</div>
        {extensionPolicy.error && <div className="settings-error-banner" role="alert">{extensionPolicy.error}</div>}
        {extensionPolicy.policy && <>
          <div className="settings-plugin-meta"><span>{t("plugin.adminPolicyVersion")}: {extensionPolicy.policy.admin.version}</span><span>{t("plugin.workspacePolicyVersion")}: {extensionPolicy.policy.workspace.version}</span><span>{t("plugin.adminPolicyBinding")}: {extensionPolicy.policy.workspace.adminPolicyVersion}</span></div>
          {canManageWorkspacePolicy && !readOnly && <form className="plugin-policy-form" onSubmit={(event) => { event.preventDefault(); const lines = (value: string) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); setPolicySaving(true); void extensionPolicy.updateWorkspace({ id: "workspace", allow: lines(policyDraft.allow), deny: lines(policyDraft.deny) }, { readPaths: lines(policyDraft.readPaths), writePaths: lines(policyDraft.writePaths), networkOrigins: lines(policyDraft.networkOrigins), secretEnv: lines(policyDraft.secretEnv) }).then(() => onShowToast(t("plugin.policySaved"))).catch((reason) => onShowToast(reason instanceof Error ? reason.message : t("plugin.policyFailed"))).finally(() => setPolicySaving(false)); }}>
            {(["allow", "deny", "readPaths", "writePaths", "networkOrigins", "secretEnv"] as const).map((field) => <label key={field}>{t(`plugin.policy.${field}`)}<textarea rows={2} value={policyDraft[field]} onChange={(event) => setPolicyDraft((current) => ({ ...current, [field]: event.target.value }))} /></label>)}
            <button className="settings-inline-btn" type="submit" disabled={policySaving}>{policySaving ? t("common.loading") : t("plugin.saveWorkspacePolicy")}</button>
          </form>}
          {!canManageWorkspacePolicy && <div className="settings-plugin-message">{t("plugin.workspacePolicyOwnerOnly")}</div>}
          {canManageWorkspacePolicy && readOnly && <div className="settings-plugin-message">{t("plugin.readOnlyPolicy")}</div>}
        </>}
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
                    explanations={permissionExplanations[plugin.manifest.id] || {}}
                    serverBinding={extensionPolicy.policy?.plugins.find((candidate) => candidate.id === plugin.manifest.id)}
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
                    explanations={permissionExplanations[plugin.manifest.id] || {}}
                    serverBinding={extensionPolicy.policy?.plugins.find((candidate) => candidate.id === plugin.manifest.id)}
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
