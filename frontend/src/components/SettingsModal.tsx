import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  Languages,
  Save,
  Settings,
  Shield,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useAdminSettings } from "../hooks/useAdminSettings";
import { useI18n } from "../i18n";
import { AdminSettings, AdminUser, LlmSettings } from "../types";
import { PluginManagerPanel } from "./PluginManagerPanel";

interface SettingsModalProps {
  token: string;
  currentUsername: string;
  isAdmin: boolean;
  visible: boolean;
  onClose: () => void;
  onShowToast: (message: string) => void;
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
  systemPrompt: string;
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
  systemPrompt: "",
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
  onClose,
  onShowToast,
}) => {
  const { locale, locales, setLocale, t } = useI18n();
  const adminSettings = useAdminSettings(token);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingLlm, setSavingLlm] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);
  const [deletingUsername, setDeletingUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateUserForm>(
    EMPTY_CREATE_USER_FORM
  );
  const [llmForm, setLlmForm] = useState<LlmFormState>(EMPTY_LLM_FORM);
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);
  const [nextPassword, setNextPassword] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminSettings.fetchSettings();
      setSettings(data);
      setLlmForm({
        vllmApiUrl: data.llm.vllmApiUrl,
        vllmApiKey: data.llm.vllmApiKey,
        modelName: data.llm.modelName,
        maxTokens: String(data.llm.maxTokens),
        systemPrompt: data.llm.systemPrompt || "",
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

    const maxTokens = Number.parseInt(llmForm.maxTokens, 10);

    const payload: LlmSettings = {
      vllmApiUrl: llmForm.vllmApiUrl.trim(),
      vllmApiKey: llmForm.vllmApiKey,
      modelName: llmForm.modelName.trim(),
      maxTokens,
      systemPrompt: llmForm.systemPrompt.trim(),
    };

    if (!payload.vllmApiUrl || !payload.modelName) {
      setError(t("settings.llmApiUrlAndModelRequired"));
      return;
    }

    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      setError(t("settings.maxTokensPositiveInteger"));
      return;
    }

    setSavingLlm(true);
    setError(null);
    try {
      const saved = await adminSettings.updateLlmSettings(payload);
      setLlmForm({
        vllmApiUrl: saved.vllmApiUrl,
        vllmApiKey: saved.vllmApiKey,
        modelName: saved.modelName,
        maxTokens: String(saved.maxTokens),
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

  return (
    <>
      <div className="settings-modal-overlay" onClick={onClose}>
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="settings-modal-header">
            <div className="settings-modal-title">
              <Settings size={18} />
              <span>{t("settings.title")}</span>
            </div>
            <button className="settings-modal-close" onClick={onClose}>
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
                <div className="settings-help-text">{t("settings.languageHelp")}</div>
              </div>
            </section>

            <PluginManagerPanel
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

                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.maxTokens")}</span>
                    <input
                      className="settings-input"
                      type="number"
                      min={1}
                      step={1}
                      value={llmForm.maxTokens}
                      onChange={(e) =>
                        setLlmForm((prev) => ({
                          ...prev,
                          maxTokens: e.target.value,
                        }))
                      }
                      placeholder="8192"
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
