import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  Languages,
  PlugZap,
  RefreshCw,
  Save,
  Settings,
  Shield,
  Trash2,
  Type,
  UserPlus,
  X,
} from "lucide-react";
import { useAdminSettings } from "../hooks/useAdminSettings";
import { useI18n } from "../i18n";
import {
  AdminSettings,
  AdminUser,
  LlmSettings,
  McpServerPreview,
  McpSettings,
  ModelCapabilities,
} from "../types";
import { PluginManagerPanel } from "./PluginManagerPanel";
import { KnowledgeManagerPanel } from "./KnowledgeManagerPanel";

interface SettingsModalProps {
  token: string;
  currentUsername: string;
  isAdmin: boolean;
  visible: boolean;
  editorFont: string;
  editorFontOptions: EditorFontOption[];
  onEditorFontChange: (fontFamily: string) => void;
  onClose: () => void;
  onShowToast: (message: string) => void;
}

interface EditorFontOption {
  label: string;
  family: string;
}

interface CreateUserForm {
  username: string;
  password: string;
  defaultWorkspace: string;
  isAdmin: boolean;
}

interface LlmFormState {
  vllmApiUrl: string;
  vllmApiKey: string;
  modelName: string;
  maxTokens: string;
  maxAgentIterations: string;
  systemPrompt: string;
}

interface AppFormState {
  uploadMaxFileSizeMb: string;
}

interface McpFormState {
  baseUrls: string;
  lazyUrls: string;
  disabledUrls: string;
  timeout: string;
  connectTimeout: string;
}

const EMPTY_CREATE_USER_FORM: CreateUserForm = {
  username: "",
  password: "",
  defaultWorkspace: "",
  isAdmin: false,
};

const EMPTY_LLM_FORM: LlmFormState = {
  vllmApiUrl: "",
  vllmApiKey: "",
  modelName: "",
  maxTokens: "8192",
  maxAgentIterations: "30",
  systemPrompt: "",
};

const EMPTY_APP_FORM: AppFormState = {
  uploadMaxFileSizeMb: "250",
};

const EMPTY_MCP_FORM: McpFormState = {
  baseUrls: "",
  lazyUrls: "",
  disabledUrls: "",
  timeout: "60",
  connectTimeout: "10",
};

function buildDefaultWorkspace(username: string, allowedRoots: string[]): string {
  const trimmedUsername = username.trim();
  if (!trimmedUsername || allowedRoots.length === 0) return "";
  const base = allowedRoots[0].replace(/\/+$/, "");
  return `${base}/${trimmedUsername}`;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  token,
  currentUsername,
  isAdmin,
  visible,
  editorFont,
  editorFontOptions,
  onEditorFontChange,
  onClose,
  onShowToast,
}) => {
  const { locale, locales, setLocale, t } = useI18n();
  const adminSettings = useAdminSettings(token);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingLlm, setSavingLlm] = useState(false);
  const [savingApp, setSavingApp] = useState(false);
  const [savingMcp, setSavingMcp] = useState(false);
  const [inspectingMcp, setInspectingMcp] = useState(false);
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilities | null>(null);
  const [loadingModelCapabilities, setLoadingModelCapabilities] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);
  const [deletingUsername, setDeletingUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateUserForm>(
    EMPTY_CREATE_USER_FORM
  );
  const [llmForm, setLlmForm] = useState<LlmFormState>(EMPTY_LLM_FORM);
  const [appForm, setAppForm] = useState<AppFormState>(EMPTY_APP_FORM);
  const [mcpForm, setMcpForm] = useState<McpFormState>(EMPTY_MCP_FORM);
  const [mcpServers, setMcpServers] = useState<McpServerPreview[]>([]);
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);
  const [nextPassword, setNextPassword] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminSettings.fetchSettings();
      setSettings(data);
      try {
        setModelCapabilities(await adminSettings.fetchLlmCapabilities());
      } catch {
        setModelCapabilities(null);
      }
      setLlmForm({
        vllmApiUrl: data.llm.vllmApiUrl,
        vllmApiKey: data.llm.vllmApiKey,
        modelName: data.llm.modelName,
        maxTokens: String(data.llm.maxTokens),
        maxAgentIterations: String(data.llm.maxAgentIterations),
        systemPrompt: data.llm.systemPrompt || "",
      });
      setAppForm({
        uploadMaxFileSizeMb: String(data.app?.uploadMaxFileSizeMb || 250),
      });
      setMcpForm({
        baseUrls: (data.mcp?.baseUrls || []).join("\n"),
        lazyUrls: (data.mcp?.lazyUrls || []).join("\n"),
        disabledUrls: (data.mcp?.disabledUrls || []).join("\n"),
        timeout: String(data.mcp?.timeout || 60),
        connectTimeout: String(data.mcp?.connectTimeout || 10),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToLoadSettings"));
    } finally {
      setLoading(false);
    }
  }, [adminSettings, t]);

  useEffect(() => {
    if (!visible || !isAdmin) return;
    void loadSettings();
  }, [visible, isAdmin, loadSettings]);

  const allowedRootsText = useMemo(() => {
    if (!settings?.allowedRoots.length) {
      return t("settings.noAllowedRootsConfigured");
    }
    return settings.allowedRoots.join(" · ");
  }, [settings, t]);
  const adminCount = useMemo(
    () => settings?.users.filter((user) => user.isAdmin).length || 0,
    [settings]
  );

  if (!visible) return null;

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingUser || !settings) return;

    const username = createForm.username.trim();
    const password = createForm.password;
    const defaultWorkspace =
      createForm.defaultWorkspace.trim() ||
      buildDefaultWorkspace(username, settings.allowedRoots);

    if (!username || !password || !defaultWorkspace) {
      setError(t("settings.usernamePasswordWorkspaceRequired"));
      return;
    }

    setCreatingUser(true);
    setError(null);
    try {
      await adminSettings.createUser({
        username,
        password,
        defaultWorkspace,
        isAdmin: createForm.isAdmin,
      });
      setCreateForm(EMPTY_CREATE_USER_FORM);
      await loadSettings();
      onShowToast(t("settings.userCreated", { username }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToCreateUser"));
    } finally {
      setCreatingUser(false);
    }
  };

  const handleDeleteUser = async (user: AdminUser) => {
    if (deletingUsername) return;
    if (!window.confirm(t("settings.confirmDeleteUser", { username: user.username }))) {
      return;
    }

    setDeletingUsername(user.username);
    setError(null);
    try {
      await adminSettings.deleteUser(user.username);
      await loadSettings();
      onShowToast(t("settings.userDeleted", { username: user.username }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToDeleteUser"));
    } finally {
      setDeletingUsername(null);
    }
  };

  const handleUpdatePassword = async () => {
    if (!passwordTarget || !nextPassword || updatingPassword) return;

    setUpdatingPassword(true);
    setError(null);
    try {
      await adminSettings.updateUserPassword(passwordTarget.username, nextPassword);
      onShowToast(
        t("settings.passwordUpdatedFor", {
          username: passwordTarget.username,
        })
      );
      setPasswordTarget(null);
      setNextPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToUpdatePassword"));
    } finally {
      setUpdatingPassword(false);
    }
  };

  const handleSaveLlm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingLlm) return;

    const maxTokens = settings?.llm.maxTokens || Number.parseInt(llmForm.maxTokens, 10) || 8192;
    const maxAgentIterations = Number.parseInt(
      llmForm.maxAgentIterations,
      10
    );

    const payload: LlmSettings = {
      vllmApiUrl: llmForm.vllmApiUrl.trim(),
      vllmApiKey: llmForm.vllmApiKey,
      modelName: llmForm.modelName.trim(),
      maxTokens,
      maxAgentIterations,
      systemPrompt: llmForm.systemPrompt.trim(),
    };

    if (!payload.vllmApiUrl || !payload.modelName) {
      setError(t("settings.llmApiUrlAndModelRequired"));
      return;
    }

    if (
      !Number.isInteger(maxTokens) ||
      maxTokens <= 0 ||
      !Number.isInteger(maxAgentIterations) ||
      maxAgentIterations <= 0
    ) {
      setError(t("settings.maxTokensPositiveInteger"));
      return;
    }

    setSavingLlm(true);
    setError(null);
    try {
      const saved = await adminSettings.updateLlmSettings(payload);
      try {
        setModelCapabilities(await adminSettings.fetchLlmCapabilities(true));
      } catch {
        setModelCapabilities(null);
      }
      setLlmForm({
        vllmApiUrl: saved.vllmApiUrl,
        vllmApiKey: saved.vllmApiKey,
        modelName: saved.modelName,
        maxTokens: String(saved.maxTokens),
        maxAgentIterations: String(saved.maxAgentIterations),
        systemPrompt: saved.systemPrompt || "",
      });
      setSettings((prev) => (prev ? { ...prev, llm: saved } : prev));
      onShowToast(t("settings.llmSettingsSaved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToSaveLlmSettings"));
    } finally {
      setSavingLlm(false);
    }
  };

  const refreshModelCapabilities = async () => {
    if (loadingModelCapabilities) return;
    setLoadingModelCapabilities(true);
    try {
      setModelCapabilities(await adminSettings.fetchLlmCapabilities(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToDetectModelCapabilities"));
    } finally {
      setLoadingModelCapabilities(false);
    }
  };

  const handleSaveApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingApp) return;

    const uploadMaxFileSizeMb = Number.parseInt(
      appForm.uploadMaxFileSizeMb,
      10
    );

    if (!Number.isInteger(uploadMaxFileSizeMb) || uploadMaxFileSizeMb <= 0) {
      setError(t("settings.uploadMaxFileSizePositiveInteger"));
      return;
    }

    setSavingApp(true);
    setError(null);
    try {
      const saved = await adminSettings.updateAppSettings({
        uploadMaxFileSizeMb,
      });
      setAppForm({
        uploadMaxFileSizeMb: String(saved.uploadMaxFileSizeMb),
      });
      setSettings((prev) => (prev ? { ...prev, app: saved } : prev));
      onShowToast(t("settings.appSettingsSaved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToSaveAppSettings"));
    } finally {
      setSavingApp(false);
    }
  };

  const handleSaveMcp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingMcp) return;

    const timeout = Number.parseInt(mcpForm.timeout, 10);
    const connectTimeout = Number.parseInt(mcpForm.connectTimeout, 10);
    if (
      !Number.isInteger(timeout) ||
      timeout <= 0 ||
      !Number.isInteger(connectTimeout) ||
      connectTimeout <= 0
    ) {
      setError(t("settings.mcpTimeoutPositiveInteger"));
      return;
    }

    const payload: McpSettings = {
      baseUrls: mcpForm.baseUrls
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
      lazyUrls: mcpForm.lazyUrls
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
      disabledUrls: mcpForm.disabledUrls
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
      timeout,
      connectTimeout,
    };

    setSavingMcp(true);
    setError(null);
    try {
      const saved = await adminSettings.updateMcpSettings(payload);
      setMcpForm({
        baseUrls: saved.baseUrls.join("\n"),
        lazyUrls: saved.lazyUrls.join("\n"),
        disabledUrls: saved.disabledUrls.join("\n"),
        timeout: String(saved.timeout),
        connectTimeout: String(saved.connectTimeout),
      });
      setSettings((prev) => (prev ? { ...prev, mcp: saved } : prev));
      setMcpServers([]);
      onShowToast(t("settings.mcpSettingsSaved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToSaveMcpSettings"));
    } finally {
      setSavingMcp(false);
    }
  };

  const handleInspectMcp = async () => {
    if (inspectingMcp) return;
    setInspectingMcp(true);
    setError(null);
    try {
      setMcpServers(await adminSettings.inspectMcpServers());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToInspectMcp"));
    } finally {
      setInspectingMcp(false);
    }
  };

  return (
    <>
      <div className="settings-modal-overlay" onClick={onClose}>
        <div className="settings-modal panel-shell" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" onClick={(e) => e.stopPropagation()}>
          <div className="settings-modal-header">
            <div className="settings-modal-title">
              <Settings size={18} />
              <div>
                <span id="settings-modal-title">{t("settings.title")}</span>
                <small>{t("settings.subtitle")}</small>
              </div>
            </div>
            <button className="settings-modal-close" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
              <X size={16} />
            </button>
          </div>

          {error && <div className="settings-error-banner">{error}</div>}

          <div className="settings-grid">
            <section className="settings-card">
              <div className="settings-card-header">
                <div className="settings-card-title">
                  <Languages size={16} />
                  <span>{t("settings.interface")}</span>
                </div>
                <span className="settings-card-meta">
                  {t("settings.interfaceMeta")}
                </span>
              </div>

              <div className="settings-form">
                <label className="settings-field settings-field-wide">
                  <span>{t("settings.language")}</span>
                  <select
                    className="settings-input"
                    value={locale}
                    onChange={(e) => setLocale(e.target.value)}
                  >
                    {locales.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field settings-field-wide">
                  <span>{t("settings.editorFont")}</span>
                  <select
                    className="settings-input"
                    value={editorFont}
                    onChange={(e) => onEditorFontChange(e.target.value)}
                  >
                    {editorFontOptions.map((option) => (
                      <option key={option.family} value={option.family}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-help-text">{t("settings.languageHelp")}</div>
              </div>
            </section>

            <PluginManagerPanel
              visible={visible}
              token={token}
              isAdmin={isAdmin}
              onShowToast={onShowToast}
            />

            <KnowledgeManagerPanel
              visible={visible}
              token={token}
              isAdmin={isAdmin}
              onShowToast={onShowToast}
            />


            {isAdmin && (
              loading && !settings ? (
                <section className="settings-card">
                  <div className="settings-loading">{t("settings.loadingAdminSettings")}</div>
                </section>
              ) : (
                <>
              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-card-title">
                    <Shield size={16} />
                    <span>{t("settings.userManagement")}</span>
                  </div>
                  <span className="settings-card-meta">
                    {t("settings.allowedRoots", { roots: allowedRootsText })}
                  </span>
                </div>

                <form className="settings-form" onSubmit={handleCreateUser}>
                  <div className="settings-form-row">
                    <label className="settings-field">
                      <span>{t("settings.username")}</span>
                      <input
                        className="settings-input"
                        value={createForm.username}
                        onChange={(e) =>
                          setCreateForm((prev) => ({
                            ...prev,
                            username: e.target.value,
                          }))
                        }
                        placeholder="new-user"
                      />
                    </label>
                    <label className="settings-field">
                      <span>{t("settings.password")}</span>
                      <input
                        className="settings-input"
                        type="password"
                        value={createForm.password}
                        onChange={(e) =>
                          setCreateForm((prev) => ({
                            ...prev,
                            password: e.target.value,
                          }))
                        }
                        placeholder={t("settings.initialPassword")}
                      />
                    </label>
                  </div>

                  <div className="settings-form-row">
                    <label className="settings-field settings-field-wide">
                      <span>{t("settings.defaultWorkspace")}</span>
                      <input
                        className="settings-input"
                        value={createForm.defaultWorkspace}
                        onChange={(e) =>
                          setCreateForm((prev) => ({
                            ...prev,
                            defaultWorkspace: e.target.value,
                          }))
                        }
                        placeholder={
                          buildDefaultWorkspace(
                            createForm.username,
                            settings?.allowedRoots || []
                          ) || "/workspace/new-user"
                        }
                      />
                    </label>
                  </div>

                  <div className="settings-form-footer">
                    <label className="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={createForm.isAdmin}
                        onChange={(e) =>
                          setCreateForm((prev) => ({
                            ...prev,
                            isAdmin: e.target.checked,
                          }))
                        }
                      />
                      <span>{t("settings.createAsAdministrator")}</span>
                    </label>
                    <button
                      className="dialog-btn primary"
                      type="submit"
                      disabled={creatingUser}
                    >
                      <UserPlus size={14} />
                      {creatingUser ? t("settings.creating") : t("settings.addUser")}
                    </button>
                  </div>
                </form>

                <div className="settings-user-list">
                  {settings?.users.map((user) => (
                    <div key={user.username} className="settings-user-row">
                      <div className="settings-user-info">
                        <div className="settings-user-name-row">
                          <span className="settings-user-name">{user.username}</span>
                          {user.isAdmin && (
                            <span className="settings-role-badge">{t("settings.admin")}</span>
                          )}
                          {user.username === currentUsername && (
                            <span className="settings-role-badge subtle">{t("settings.current")}</span>
                          )}
                        </div>
                        <div className="settings-user-path">
                          {user.defaultWorkspace}
                        </div>
                      </div>
                      <div className="settings-user-actions">
                        <button
                          className="settings-inline-btn"
                          onClick={() => {
                            setPasswordTarget(user);
                            setNextPassword("");
                          }}
                        >
                          <KeyRound size={14} />
                          {t("settings.changePassword")}
                        </button>
                        <button
                          className="settings-inline-btn danger"
                          onClick={() => void handleDeleteUser(user)}
                          disabled={
                            deletingUsername === user.username ||
                            user.username === currentUsername ||
                            (user.isAdmin && adminCount <= 1)
                          }
                        >
                          <Trash2 size={14} />
                          {deletingUsername === user.username
                            ? t("settings.deleting")
                            : t("common.delete")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-card-title">
                    <PlugZap size={16} />
                    <span>{t("settings.mcpConfiguration")}</span>
                  </div>
                  <span className="settings-card-meta">
                    {t("settings.mcpMeta")}
                  </span>
                </div>

                <form className="settings-form" onSubmit={handleSaveMcp}>
                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.mcpEndpoints")}</span>
                    <textarea
                      className="settings-input"
                      rows={4}
                      value={mcpForm.baseUrls}
                      onChange={(e) =>
                        setMcpForm((prev) => ({ ...prev, baseUrls: e.target.value }))
                      }
                      placeholder="http://host.docker.internal:8444/mcp"
                      style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: "12px" }}
                    />
                  </label>
                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.mcpLazyEndpoints")}</span>
                    <textarea
                      className="settings-input"
                      rows={3}
                      value={mcpForm.lazyUrls}
                      onChange={(e) => setMcpForm((prev) => ({ ...prev, lazyUrls: e.target.value }))}
                      placeholder={t("settings.mcpLazyEndpointsPlaceholder")}
                      style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: "12px" }}
                    />
                  </label>
                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.mcpDisabledEndpoints")}</span>
                    <textarea
                      className="settings-input"
                      rows={2}
                      value={mcpForm.disabledUrls}
                      onChange={(e) => setMcpForm((prev) => ({ ...prev, disabledUrls: e.target.value }))}
                      placeholder={t("settings.mcpDisabledEndpointsPlaceholder")}
                      style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: "12px" }}
                    />
                  </label>
                  <div className="settings-form-row">
                    <label className="settings-field">
                      <span>{t("settings.mcpTimeout")}</span>
                      <input
                        className="settings-input"
                        type="number"
                        min={1}
                        step={1}
                        value={mcpForm.timeout}
                        onChange={(e) => setMcpForm((prev) => ({ ...prev, timeout: e.target.value }))}
                      />
                    </label>
                    <label className="settings-field">
                      <span>{t("settings.mcpConnectTimeout")}</span>
                      <input
                        className="settings-input"
                        type="number"
                        min={1}
                        step={1}
                        value={mcpForm.connectTimeout}
                        onChange={(e) => setMcpForm((prev) => ({ ...prev, connectTimeout: e.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="settings-form-footer">
                    <span className="settings-help-text">{t("settings.mcpHelp")}</span>
                    <div className="settings-form-actions">
                      <button
                        className="dialog-btn"
                        type="button"
                        onClick={() => void handleInspectMcp()}
                        disabled={inspectingMcp}
                      >
                        <RefreshCw size={14} />
                        {inspectingMcp ? t("settings.mcpInspecting") : t("settings.mcpInspect")}
                      </button>
                      <button className="dialog-btn primary" type="submit" disabled={savingMcp}>
                        <Save size={14} />
                        {savingMcp ? t("settings.saving") : t("settings.saveMcpSettings")}
                      </button>
                    </div>
                  </div>
                </form>

                {mcpServers.length > 0 && (
                  <div className="settings-mcp-list">
                    {mcpServers.map((server) => (
                      <div className="settings-mcp-row" key={server.endpointKey}>
                        <div className="settings-mcp-info">
                          <code>{server.endpoint}</code>
                          <span>
                            {server.ok ? t("settings.mcpServerReady") : server.error || t("settings.mcpServerFailed")}
                            {server.ok && server.latencyMs !== undefined
                              ? ` · ${server.latencyMs}ms${server.attempts && server.attempts > 1 ? ` · ${t("settings.mcpAttempts", { count: server.attempts })}` : ""}`
                              : ""}
                          </span>
                        </div>
                        <span className={`settings-mcp-badge${server.ok ? " ready" : " failed"}`}>
                          {server.ok ? t("settings.mcpToolCount", { count: server.toolCount }) : t("settings.mcpServerFailed")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-card-title">
                    <Type size={16} />
                    <span>{t("settings.appConfiguration")}</span>
                  </div>
                  <span className="settings-card-meta">
                    {t("settings.appMeta")}
                  </span>
                </div>

                <form className="settings-form" onSubmit={handleSaveApp}>
                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.uploadMaxFileSizeMb")}</span>
                    <input
                      className="settings-input"
                      type="number"
                      min={1}
                      step={1}
                      value={appForm.uploadMaxFileSizeMb}
                      onChange={(e) =>
                        setAppForm((prev) => ({
                          ...prev,
                          uploadMaxFileSizeMb: e.target.value,
                        }))
                      }
                      placeholder="250"
                    />
                  </label>

                  <div className="settings-form-footer">
                    <span className="settings-help-text">
                      {t("settings.uploadMaxFileSizeHelp")}
                    </span>
                    <button
                      className="dialog-btn primary"
                      type="submit"
                      disabled={savingApp}
                    >
                      <Save size={14} />
                      {savingApp ? t("settings.saving") : t("settings.saveAppSettings")}
                    </button>
                  </div>
                </form>
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-card-title">
                    <Save size={16} />
                    <span>{t("settings.llmConfiguration")}</span>
                  </div>
                  <span className="settings-card-meta">
                    {t("settings.llmMeta")}
                  </span>
                </div>

                <form className="settings-form" onSubmit={handleSaveLlm}>
                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.apiUrl")}</span>
                    <input
                      className="settings-input"
                      value={llmForm.vllmApiUrl}
                      onChange={(e) =>
                        setLlmForm((prev) => ({
                          ...prev,
                          vllmApiUrl: e.target.value,
                        }))
                      }
                      placeholder="http://host.docker.internal:8000/v1"
                    />
                  </label>

                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.apiKey")}</span>
                    <input
                      className="settings-input"
                      type="password"
                      value={llmForm.vllmApiKey}
                      onChange={(e) =>
                        setLlmForm((prev) => ({
                          ...prev,
                          vllmApiKey: e.target.value,
                        }))
                      }
                      placeholder={t("settings.optionalBearerToken")}
                    />
                  </label>

                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.modelName")}</span>
                    <input
                      className="settings-input"
                      value={llmForm.modelName}
                      onChange={(e) =>
                        setLlmForm((prev) => ({
                          ...prev,
                          modelName: e.target.value,
                        }))
                      }
                      placeholder="default"
                    />
                  </label>

                  <div className="settings-field settings-field-wide">
                    <span>{t("settings.maxTokens")}</span>
                    <div className="settings-auto-value">
                      <div>
                        <strong>
                          {modelCapabilities?.maxOutputTokens || llmForm.maxTokens || "—"} tokens
                        </strong>
                        <small>
                          {modelCapabilities
                            ? t(`settings.modelCapabilitySource.${modelCapabilities.source}`)
                            : t("settings.modelCapabilityUnavailable")}
                          {modelCapabilities?.contextWindow
                            ? ` · ${t("settings.contextWindow", { count: modelCapabilities.contextWindow })}`
                            : ""}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="settings-inline-btn"
                        onClick={() => void refreshModelCapabilities()}
                        disabled={loadingModelCapabilities}
                        title={t("settings.refreshModelCapabilities")}
                      >
                        <RefreshCw size={13} className={loadingModelCapabilities ? "chat-spin" : ""} />
                        {t("settings.refreshModelCapabilities")}
                      </button>
                    </div>
                    {modelCapabilities?.warning && (
                      <small className="settings-help-text">{modelCapabilities.warning}</small>
                    )}
                  </div>

                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.maxAgentIterations")}</span>
                    <input
                      className="settings-input"
                      type="number"
                      min={1}
                      step={1}
                      value={llmForm.maxAgentIterations}
                      onChange={(e) =>
                        setLlmForm((prev) => ({
                          ...prev,
                          maxAgentIterations: e.target.value,
                        }))
                      }
                      placeholder="30"
                    />
                  </label>

                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.systemPrompt")}</span>
                    <textarea
                      className="settings-input"
                      rows={6}
                      value={llmForm.systemPrompt}
                      onChange={(e) =>
                        setLlmForm((prev) => ({
                          ...prev,
                          systemPrompt: e.target.value,
                        }))
                      }
                      placeholder={t("settings.customSystemPromptPlaceholder")}
                      style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: "12px" }}
                    />
                  </label>

                  <div className="settings-form-footer">
                    <span className="settings-help-text">
                      {t("settings.llmHelp")}
                    </span>
                    <button
                      className="dialog-btn primary"
                      type="submit"
                      disabled={savingLlm}
                    >
                      <Save size={14} />
                      {savingLlm ? t("settings.saving") : t("settings.saveLlmSettings")}
                    </button>
                  </div>
                </form>
              </section>
                </>
              )
            )}
          </div>
        </div>
      </div>

      {passwordTarget && (
        <div
          className="settings-password-overlay"
          onClick={() => {
            if (updatingPassword) return;
            setPasswordTarget(null);
            setNextPassword("");
          }}
        >
          <div
            className="dialog settings-password-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-title">
              {t("settings.changePasswordFor", {
                username: passwordTarget.username,
              })}
            </div>
            <input
              className="dialog-input"
              type="password"
              value={nextPassword}
              onChange={(e) => setNextPassword(e.target.value)}
              placeholder={t("settings.enterNewPassword")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleUpdatePassword();
                }
              }}
            />
            <div className="dialog-actions">
              <button
                className="dialog-btn"
                onClick={() => {
                  setPasswordTarget(null);
                  setNextPassword("");
                }}
                disabled={updatingPassword}
              >
                {t("common.cancel")}
              </button>
              <button
                className="dialog-btn primary"
                onClick={() => void handleUpdatePassword()}
                disabled={!nextPassword || updatingPassword}
              >
                {updatingPassword ? t("settings.saving") : t("settings.updatePassword")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
