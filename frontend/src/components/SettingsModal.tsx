import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  Save,
  Settings,
  Shield,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useAdminSettings } from "../hooks/useAdminSettings";
import { AdminSettings, AdminUser, LlmSettings } from "../types";

interface SettingsModalProps {
  token: string;
  currentUsername: string;
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

const EMPTY_CREATE_USER_FORM: CreateUserForm = {
  username: "",
  password: "",
  defaultWorkspace: "",
  isAdmin: false,
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
  visible,
  onClose,
  onShowToast,
}) => {
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
  const [llmForm, setLlmForm] = useState<LlmSettings>({
    vllmApiUrl: "",
    vllmApiKey: "",
    modelName: "",
  });
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);
  const [nextPassword, setNextPassword] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminSettings.fetchSettings();
      setSettings(data);
      setLlmForm(data.llm);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, [adminSettings]);

  useEffect(() => {
    if (!visible) return;
    void loadSettings();
  }, [visible, loadSettings]);

  const allowedRootsText = useMemo(() => {
    if (!settings?.allowedRoots.length) return "No allowed roots configured";
    return settings.allowedRoots.join(" · ");
  }, [settings]);
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
      setError("Username, password and default workspace are required");
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
      onShowToast(`User ${username} created`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create user");
    } finally {
      setCreatingUser(false);
    }
  };

  const handleDeleteUser = async (user: AdminUser) => {
    if (deletingUsername) return;
    if (!window.confirm(`Delete user "${user.username}"?`)) return;

    setDeletingUsername(user.username);
    setError(null);
    try {
      await adminSettings.deleteUser(user.username);
      await loadSettings();
      onShowToast(`User ${user.username} deleted`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete user");
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
      onShowToast(`Password updated for ${passwordTarget.username}`);
      setPasswordTarget(null);
      setNextPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update password");
    } finally {
      setUpdatingPassword(false);
    }
  };

  const handleSaveLlm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingLlm) return;

    const payload: LlmSettings = {
      vllmApiUrl: llmForm.vllmApiUrl.trim(),
      vllmApiKey: llmForm.vllmApiKey,
      modelName: llmForm.modelName.trim(),
    };

    if (!payload.vllmApiUrl || !payload.modelName) {
      setError("LLM API URL and model name are required");
      return;
    }

    setSavingLlm(true);
    setError(null);
    try {
      const saved = await adminSettings.updateLlmSettings(payload);
      setLlmForm(saved);
      setSettings((prev) => (prev ? { ...prev, llm: saved } : prev));
      onShowToast("LLM settings saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save LLM settings");
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
              <span>Admin Settings</span>
            </div>
            <button className="settings-modal-close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>

          {error && <div className="settings-error-banner">{error}</div>}

          {loading && !settings ? (
            <div className="settings-loading">Loading settings...</div>
          ) : (
            <div className="settings-grid">
              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-card-title">
                    <Shield size={16} />
                    <span>User Management</span>
                  </div>
                  <span className="settings-card-meta">
                    Allowed roots: {allowedRootsText}
                  </span>
                </div>

                <form className="settings-form" onSubmit={handleCreateUser}>
                  <div className="settings-form-row">
                    <label className="settings-field">
                      <span>Username</span>
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
                      <span>Password</span>
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
                        placeholder="Initial password"
                      />
                    </label>
                  </div>

                  <div className="settings-form-row">
                    <label className="settings-field settings-field-wide">
                      <span>Default Workspace</span>
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
                      <span>Create as administrator</span>
                    </label>
                    <button
                      className="dialog-btn primary"
                      type="submit"
                      disabled={creatingUser}
                    >
                      <UserPlus size={14} />
                      {creatingUser ? "Creating..." : "Add User"}
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
                            <span className="settings-role-badge">Admin</span>
                          )}
                          {user.username === currentUsername && (
                            <span className="settings-role-badge subtle">Current</span>
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
                          Change Password
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
                            ? "Deleting..."
                            : "Delete"}
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
                    <span>LLM Configuration</span>
                  </div>
                  <span className="settings-card-meta">
                    Saved changes apply to new requests immediately
                  </span>
                </div>

                <form className="settings-form" onSubmit={handleSaveLlm}>
                  <label className="settings-field settings-field-wide">
                    <span>API URL</span>
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
                    <span>API Key</span>
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
                      placeholder="Optional bearer token"
                    />
                  </label>

                  <label className="settings-field settings-field-wide">
                    <span>Model Name</span>
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

                  <div className="settings-form-footer">
                    <span className="settings-help-text">
                      API key can be empty if your endpoint does not require auth.
                    </span>
                    <button
                      className="dialog-btn primary"
                      type="submit"
                      disabled={savingLlm}
                    >
                      <Save size={14} />
                      {savingLlm ? "Saving..." : "Save LLM Settings"}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}
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
              Change Password: {passwordTarget.username}
            </div>
            <input
              className="dialog-input"
              type="password"
              value={nextPassword}
              onChange={(e) => setNextPassword(e.target.value)}
              placeholder="Enter new password"
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
                Cancel
              </button>
              <button
                className="dialog-btn primary"
                onClick={() => void handleUpdatePassword()}
                disabled={!nextPassword || updatingPassword}
              >
                {updatingPassword ? "Saving..." : "Update Password"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
