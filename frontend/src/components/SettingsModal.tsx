import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  KeyRound,
  Languages,
  Plus,
  PlugZap,
  Power,
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
  AgentProfileOverrides,
  AdminUser,
  LlmSettings,
  McpServerPreview,
  McpSettings,
  ModelCapabilities,
  TeamRole,
} from "../types";
import { PluginManagerPanel } from "./PluginManagerPanel";
import { KnowledgeManagerPanel } from "./KnowledgeManagerPanel";
import { ModelGovernancePanel } from "./ModelGovernancePanel";
import { ActionConfirmDialog } from "./ActionConfirmDialog";
import { WorkbenchSelect } from "./WorkbenchSelect";
import { useModalDialogFocus } from "./useModalDialogFocus";

interface SettingsModalProps {
  token: string;
  currentUsername: string;
  isAdmin: boolean;
  teamRole?: TeamRole | null;
  readOnlyWorkspace?: boolean;
  workspaceId: string;
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
  endpoints: LlmEndpointForm[];
  maxAgentIterations: string;
  systemPrompt: string;
}

type LlmSamplingField =
  | "temperature"
  | "topP"
  | "frequencyPenalty"
  | "presencePenalty"
  | "maxTokens";

const LLM_PARAMETER_INPUTS: Array<{ field: LlmSamplingField; min: number; max?: number; step: string }> = [
  { field: "temperature", min: 0, max: 2, step: "any" },
  { field: "topP", min: 0, max: 1, step: "any" },
  { field: "frequencyPenalty", min: -2, max: 2, step: "any" },
  { field: "presencePenalty", min: -2, max: 2, step: "any" },
  { field: "maxTokens", min: 1, max: 1_000_000, step: "1" },
];

interface LlmModelForm extends Record<LlmSamplingField, string> {
  id: number;
  modelName: string;
  supportsImageInput: boolean;
  supportsPdfInput: boolean;
}

interface LlmEndpointForm {
  id: number;
  apiUrl: string;
  apiKey: string;
  models: LlmModelForm[];
}

let nextLlmFormId = 0;

function createLlmModel(model?: {
  modelName?: string;
  temperature?: number | null;
  topP?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  maxTokens?: number | null;
  supportsImageInput?: boolean;
  supportsPdfInput?: boolean;
}): LlmModelForm {
  return {
    id: ++nextLlmFormId,
    modelName: model?.modelName || "",
    temperature: model?.temperature?.toString() || "",
    topP: model?.topP?.toString() || "",
    frequencyPenalty: model?.frequencyPenalty?.toString() || "",
    presencePenalty: model?.presencePenalty?.toString() || "",
    maxTokens: model?.maxTokens?.toString() || "",
    supportsImageInput: model?.supportsImageInput === true,
    supportsPdfInput: model?.supportsPdfInput === true,
  };
}

function createLlmEndpoint(apiUrl = "", apiKey = "", model = createLlmModel()): LlmEndpointForm {
  return { id: ++nextLlmFormId, apiUrl, apiKey, models: [model] };
}

function llmSettingsToForm(settings: LlmSettings): LlmFormState {
  const endpoints = [createLlmEndpoint(settings.vllmApiUrl, settings.vllmApiKey, createLlmModel({
    modelName: settings.modelName,
    temperature: settings.temperature,
    topP: settings.topP,
    frequencyPenalty: settings.frequencyPenalty,
    presencePenalty: settings.presencePenalty,
    maxTokens: settings.maxTokens,
    supportsImageInput: settings.supportsImageInput,
    supportsPdfInput: settings.supportsPdfInput,
  }))];
  for (const model of Array.isArray(settings.models) ? settings.models : []) {
    // Credentials, including an empty key, define one endpoint group.
    let endpoint = endpoints.find((item) => item.apiUrl === model.apiUrl && item.apiKey === model.apiKey);
    if (!endpoint) {
      endpoint = createLlmEndpoint(model.apiUrl, model.apiKey, createLlmModel(model));
      endpoints.push(endpoint);
    } else {
      endpoint.models.push(createLlmModel(model));
    }
  }
  return {
    endpoints,
    maxAgentIterations: String(settings.maxAgentIterations),
    systemPrompt: settings.systemPrompt || "",
  };
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
  serversJson: string;
}

const EMPTY_CREATE_USER_FORM: CreateUserForm = {
  username: "",
  password: "",
  defaultWorkspace: "",
  isAdmin: false,
};

const EMPTY_LLM_FORM: LlmFormState = {
  endpoints: [createLlmEndpoint("", "", createLlmModel({ maxTokens: 8192 }))],
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
  serversJson: "[]",
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
  teamRole = null,
  readOnlyWorkspace = false,
  workspaceId,
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
  const [savingAgents, setSavingAgents] = useState(false);
  const [inspectingMcp, setInspectingMcp] = useState(false);
  const [togglingMcpEndpoint, setTogglingMcpEndpoint] = useState<string | null>(null);
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilities | null>(null);
  const [modelCapabilityError, setModelCapabilityError] = useState<string | null>(null);
  const [loadingModelCapabilities, setLoadingModelCapabilities] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);
  const [deletingUsername, setDeletingUsername] = useState<string | null>(null);
  const [reviewingRegistration, setReviewingRegistration] = useState<{
    username: string;
    action: "approve" | "reject";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateUserForm>(
    EMPTY_CREATE_USER_FORM
  );
  const [llmForm, setLlmForm] = useState<LlmFormState>(EMPTY_LLM_FORM);
  const [appForm, setAppForm] = useState<AppFormState>(EMPTY_APP_FORM);
  const [mcpForm, setMcpForm] = useState<McpFormState>(EMPTY_MCP_FORM);
  const [agentProfilesJson, setAgentProfilesJson] = useState("{}");
  const [mcpServers, setMcpServers] = useState<McpServerPreview[]>([]);
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);
  const [nextPassword, setNextPassword] = useState("");
  const [confirmation, setConfirmation] = useState<
    | { kind: "delete-user"; user: AdminUser }
    | { kind: "reject-registration"; username: string }
    | null
  >(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closePasswordDialog = useCallback(() => {
    if (updatingPassword) return;
    setPasswordTarget(null);
    setNextPassword("");
    setError(null);
  }, [updatingPassword]);
  const passwordDialogRef = useModalDialogFocus<HTMLDivElement>({
    open: visible && Boolean(passwordTarget),
    onClose: closePasswordDialog,
    initialFocusRef: passwordInputRef,
  });
  const nestedModalOpen = Boolean(passwordTarget || confirmation);

  useEffect(() => {
    if (!visible) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => { requestAnimationFrame(() => returnFocusRef.current?.focus()); };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (confirmation || passwordTarget) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmation, onClose, passwordTarget, visible]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminSettings.fetchSettings();
      setSettings(data);
      setModelCapabilityError(null);
      try {
        setModelCapabilities(await adminSettings.fetchLlmCapabilities());
      } catch (capabilityError) {
        setModelCapabilities(null);
        setModelCapabilityError(
          capabilityError instanceof Error
            ? capabilityError.message
            : t("settings.failedToDetectModelCapabilities")
        );
      }
      setLlmForm(llmSettingsToForm(data.llm));
      setAppForm({
        uploadMaxFileSizeMb: String(data.app?.uploadMaxFileSizeMb || 250),
      });
      setMcpForm({
        baseUrls: (data.mcp?.baseUrls || []).join("\n"),
        lazyUrls: (data.mcp?.lazyUrls || []).join("\n"),
        disabledUrls: (data.mcp?.disabledUrls || []).join("\n"),
        timeout: String(data.mcp?.timeout || 60),
        connectTimeout: String(data.mcp?.connectTimeout || 10),
        serversJson: JSON.stringify(data.mcp?.servers || [], null, 2),
      });
      setAgentProfilesJson(JSON.stringify(data.agents || {}, null, 2));
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
  const mcpHasUnsavedChanges = useMemo(() => {
    const saved = settings?.mcp;
    if (!saved) return false;
    return (
      mcpForm.baseUrls !== saved.baseUrls.join("\n") ||
      mcpForm.lazyUrls !== saved.lazyUrls.join("\n") ||
      mcpForm.disabledUrls !== saved.disabledUrls.join("\n") ||
      mcpForm.timeout !== String(saved.timeout) ||
      mcpForm.connectTimeout !== String(saved.connectTimeout) ||
      mcpForm.serversJson !== JSON.stringify(saved.servers || [], null, 2)
    );
  }, [mcpForm, settings?.mcp]);

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
    setDeletingUsername(user.username);
    setError(null);
    try {
      await adminSettings.deleteUser(user.username);
      await loadSettings();
      onShowToast(t("settings.userDeleted", { username: user.username }));
      setConfirmation(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToDeleteUser"));
    } finally {
      setDeletingUsername(null);
    }
  };

  const handleApproveRegistration = async (username: string) => {
    if (reviewingRegistration || !settings) return;
    setReviewingRegistration({ username, action: "approve" });
    setError(null);
    try {
      await adminSettings.approveRegistration(
        username,
        buildDefaultWorkspace(username, settings.allowedRoots)
      );
      await loadSettings();
      onShowToast(t("settings.registrationApproved", { username }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToApproveRegistration"));
    } finally {
      setReviewingRegistration(null);
    }
  };

  const handleRejectRegistration = async (username: string) => {
    if (reviewingRegistration) return;
    setReviewingRegistration({ username, action: "reject" });
    setError(null);
    try {
      await adminSettings.rejectRegistration(username);
      await loadSettings();
      onShowToast(t("settings.registrationRejected", { username }));
      setConfirmation(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.failedToRejectRegistration"));
    } finally {
      setReviewingRegistration(null);
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

  const updateLlmEndpoint = (endpointId: number, field: "apiUrl" | "apiKey", value: string) => {
    setLlmForm((prev) => ({
      ...prev,
      endpoints: prev.endpoints.map((endpoint) =>
        endpoint.id === endpointId ? { ...endpoint, [field]: value } : endpoint
      ),
    }));
  };

  const updateLlmModel = (endpointId: number, modelId: number, field: "modelName" | LlmSamplingField | "supportsImageInput" | "supportsPdfInput", value: string | boolean) => {
    setLlmForm((prev) => ({
      ...prev,
      endpoints: prev.endpoints.map((endpoint) =>
        endpoint.id === endpointId
          ? { ...endpoint, models: endpoint.models.map((model) =>
            model.id === modelId ? { ...model, [field]: value } : model
          ) }
          : endpoint
      ),
    }));
  };

  const setDefaultLlmModel = (endpointId: number, modelId: number) => {
    setLlmForm((prev) => {
      const selectedEndpoint = prev.endpoints.find((endpoint) => endpoint.id === endpointId);
      const selectedModel = selectedEndpoint?.models.find((model) => model.id === modelId);
      if (!selectedEndpoint || !selectedModel) return prev;
      const previousDefault = prev.endpoints[0]?.models[0];
      const promotedModel = { ...selectedModel };
      for (const { field } of LLM_PARAMETER_INPUTS) {
        if (!promotedModel[field].trim()) promotedModel[field] = previousDefault?.[field] || "";
      }
      return {
        ...prev,
        endpoints: [
          { ...selectedEndpoint, models: [promotedModel, ...selectedEndpoint.models.filter((model) => model.id !== modelId)] },
          ...prev.endpoints.filter((endpoint) => endpoint.id !== endpointId),
        ],
      };
    });
  };

  const handleSaveLlm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingLlm) return;

    const endpoints = llmForm.endpoints;
    const allModels = endpoints.flatMap((endpoint) => endpoint.models);
    if (!endpoints[0]?.models[0] || endpoints.some((endpoint) => !endpoint.apiUrl.trim() || !endpoint.models.length || endpoint.models.some((model) => !model.modelName.trim()))) {
      setError(t("settings.endpointModelsRequired"));
      return;
    }
    if (allModels.length > 33) {
      setError(t("settings.modelLimit"));
      return;
    }
    const modelNames = allModels.map((model) => model.modelName.trim());
    if (new Set(modelNames).size !== modelNames.length) {
      setError(t("settings.duplicateModelName"));
      return;
    }

    const values = new Map<number, Partial<Record<LlmSamplingField, number>>>();
    const ranges: Record<Exclude<LlmSamplingField, "maxTokens">, [number, number]> = {
      temperature: [0, 2],
      topP: [0, 1],
      frequencyPenalty: [-2, 2],
      presencePenalty: [-2, 2],
    };
    for (const model of allModels) {
      const modelValues: Partial<Record<LlmSamplingField, number>> = {};
      for (const field of ["temperature", "topP", "frequencyPenalty", "presencePenalty"] as const) {
        if (!model[field].trim()) continue;
        const value = Number(model[field]);
        const [min, max] = ranges[field];
        if (!Number.isFinite(value) || value < min || value > max) {
          setError(t("settings.modelParameterRange", {
            model: model.modelName.trim(), parameter: t(`settings.${field}`), min, max,
          }));
          return;
        }
        modelValues[field] = value;
      }
      if (model.maxTokens.trim()) {
        const maxTokens = Number(model.maxTokens);
        if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > 1_000_000) {
          setError(t("settings.modelMaxTokensPositiveInteger", { model: model.modelName.trim() }));
          return;
        }
        modelValues.maxTokens = maxTokens;
      }
      values.set(model.id, modelValues);
    }
    const defaultEndpoint = endpoints[0];
    const defaultModel = defaultEndpoint.models[0];
    const defaultValues = values.get(defaultModel.id)!;
    if (defaultValues.maxTokens === undefined) {
      setError(t("settings.modelMaxTokensPositiveInteger", { model: defaultModel.modelName.trim() }));
      return;
    }
    const maxAgentIterations = Number(llmForm.maxAgentIterations);
    if (!Number.isSafeInteger(maxAgentIterations) || maxAgentIterations <= 0) {
      setError(t("settings.maxAgentIterationsPositiveInteger"));
      return;
    }

    const payload: LlmSettings = {
      vllmApiUrl: defaultEndpoint.apiUrl.trim(),
      vllmApiKey: defaultEndpoint.apiKey,
      modelName: defaultModel.modelName.trim(),
      temperature: defaultValues.temperature ?? null,
      topP: defaultValues.topP ?? null,
      frequencyPenalty: defaultValues.frequencyPenalty ?? null,
      presencePenalty: defaultValues.presencePenalty ?? null,
      maxTokens: defaultValues.maxTokens,
      supportsImageInput: defaultModel.supportsImageInput,
      supportsPdfInput: defaultModel.supportsPdfInput,
      models: endpoints.flatMap((endpoint, endpointIndex) => endpoint.models.flatMap((model, modelIndex) => {
        if (endpointIndex === 0 && modelIndex === 0) return [];
        return [{
          modelName: model.modelName.trim(),
          apiUrl: endpoint.apiUrl.trim(),
          apiKey: endpoint.apiKey,
          supportsImageInput: model.supportsImageInput,
          supportsPdfInput: model.supportsPdfInput,
          ...values.get(model.id),
        }];
      })),
      maxAgentIterations,
      systemPrompt: llmForm.systemPrompt.trim(),
    };

    setSavingLlm(true);
    setError(null);
    try {
      const saved = await adminSettings.updateLlmSettings(payload);
      setModelCapabilityError(null);
      try {
        setModelCapabilities(await adminSettings.fetchLlmCapabilities(true));
      } catch (capabilityError) {
        setModelCapabilities(null);
        setModelCapabilityError(
          capabilityError instanceof Error
            ? capabilityError.message
            : t("settings.failedToDetectModelCapabilities")
        );
      }
      setLlmForm(llmSettingsToForm(saved));
      setSettings((prev) => (prev ? { ...prev, llm: saved } : prev));
      window.dispatchEvent(new Event("crewforge:llm-models-updated"));
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
    setModelCapabilityError(null);
    try {
      setModelCapabilities(await adminSettings.fetchLlmCapabilities(true));
    } catch (e) {
      setModelCapabilityError(e instanceof Error ? e.message : t("settings.failedToDetectModelCapabilities"));
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

    let servers: McpSettings["servers"];
    try {
      const parsed = JSON.parse(mcpForm.serversJson || "[]");
      if (!Array.isArray(parsed)) throw new Error(t("settings.mcpServersJsonArray"));
      servers = parsed as McpSettings["servers"];
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : t("settings.mcpServersJsonInvalid"));
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
      servers,
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
        serversJson: JSON.stringify(saved.servers || [], null, 2),
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

  const handleSaveAgentProfiles = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingAgents) return;
    let profiles: AgentProfileOverrides;
    try {
      const parsed = JSON.parse(agentProfilesJson || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(t("settings.agentProfilesJsonObject"));
      }
      profiles = parsed as AgentProfileOverrides;
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : t("settings.agentProfilesJsonInvalid"));
      return;
    }
    setSavingAgents(true);
    setError(null);
    try {
      const saved = await adminSettings.updateAgentSettings(profiles);
      setAgentProfilesJson(JSON.stringify(saved, null, 2));
      setSettings((previous) => previous ? { ...previous, agents: saved } : previous);
      onShowToast(t("settings.agentProfilesSaved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("settings.agentProfilesSaveFailed"));
    } finally {
      setSavingAgents(false);
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

  const handleSetMcpEnabled = async (server: McpServerPreview, enabled: boolean) => {
    if (!settings?.mcp || togglingMcpEndpoint) return;
    const current = settings.mcp;
    const advancedServers = [...(current.servers || [])];
    const advancedIndex = advancedServers.findIndex((candidate) => {
      if (candidate.id !== server.configId || candidate.transport !== server.transport) return false;
      return candidate.transport === "remote"
        ? candidate.url.replace(/\/+$/, "") === server.endpoint.replace(/\/+$/, "")
        : server.endpoint === `stdio:${candidate.id}`;
    });
    if (advancedIndex >= 0) {
      advancedServers[advancedIndex] = {
        ...advancedServers[advancedIndex],
        disabled: !enabled,
      };
    }
    const disabledUrls = current.disabledUrls.filter(
      (url) => url.replace(/\/+$/, "") !== server.endpoint.replace(/\/+$/, "")
    );
    if (advancedIndex < 0 && !enabled) disabledUrls.push(server.endpoint);

    setTogglingMcpEndpoint(server.endpointKey);
    setError(null);
    try {
      const saved = await adminSettings.updateMcpSettings({
        ...current,
        disabledUrls,
        servers: advancedServers,
      });
      setMcpForm({
        baseUrls: saved.baseUrls.join("\n"),
        lazyUrls: saved.lazyUrls.join("\n"),
        disabledUrls: saved.disabledUrls.join("\n"),
        timeout: String(saved.timeout),
        connectTimeout: String(saved.connectTimeout),
        serversJson: JSON.stringify(saved.servers || [], null, 2),
      });
      setSettings((previous) => previous ? { ...previous, mcp: saved } : previous);
      setMcpServers(await adminSettings.inspectMcpServers());
      onShowToast(enabled ? t("settings.mcpEnabled") : t("settings.mcpDisabled"));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : t("settings.failedToSaveMcpSettings"));
    } finally {
      setTogglingMcpEndpoint(null);
    }
  };

  const totalLlmModels = llmForm.endpoints.reduce((count, endpoint) => count + endpoint.models.length, 0);
  const formDefaultEndpoint = llmForm.endpoints[0];
  const capabilitiesMatchSavedDefault = Boolean(settings && formDefaultEndpoint
    && formDefaultEndpoint.apiUrl.trim() === settings.llm.vllmApiUrl
    && formDefaultEndpoint.apiKey === settings.llm.vllmApiKey
    && formDefaultEndpoint.models[0]?.modelName.trim() === settings.llm.modelName);
  const displayedModelCapabilities = capabilitiesMatchSavedDefault ? modelCapabilities : null;

  return (
    <>
      <div className="settings-modal-overlay" onClick={onClose}>
        <div ref={modalRef} className="settings-modal panel-shell" role="dialog" aria-modal={nestedModalOpen ? undefined : true} inert={passwordTarget || confirmation ? true : undefined} aria-hidden={passwordTarget || confirmation ? true : undefined} aria-labelledby="settings-modal-title" onClick={(e) => e.stopPropagation()}>
          <div className="settings-modal-header">
            <div className="settings-modal-title">
              <Settings size={18} />
              <div>
                <span id="settings-modal-title">{t("settings.title")}</span>
                <small>{t("settings.subtitle")}</small>
              </div>
            </div>
            <button ref={closeRef} className="settings-modal-close" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
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
                <div className="settings-field settings-field-wide">
                  <span>{t("settings.language")}</span>
                  <WorkbenchSelect
                    label={t("settings.language")}
                    value={locale}
                    onChange={setLocale}
                    options={locales.map((option) => ({ value: option.code, label: option.label }))}
                  />
                </div>
                <div className="settings-field settings-field-wide">
                  <span>{t("settings.editorFont")}</span>
                  <WorkbenchSelect
                    label={t("settings.editorFont")}
                    value={editorFont}
                    onChange={onEditorFontChange}
                    options={editorFontOptions.map((option) => ({ value: option.family, label: option.label }))}
                  />
                </div>
                <div className="settings-help-text">{t("settings.languageHelp")}</div>
              </div>
            </section>

            <PluginManagerPanel
              visible={visible}
              token={token}
              isAdmin={isAdmin}
              teamRole={teamRole}
              readOnly={readOnlyWorkspace}
              onShowToast={onShowToast}
            />

            <ModelGovernancePanel
              token={token}
              visible={visible}
              modelName={llmForm.endpoints[0]?.models[0]?.modelName || settings?.llm.modelName || ""}
              workspaceId={workspaceId}
              readOnly={readOnlyWorkspace}
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

                <div className="settings-registration-list">
                  <div className="settings-registration-heading">
                    <span>{t("settings.pendingRegistrations")}</span>
                    <span>{t("settings.pendingRegistrationCount", {
                      count: settings?.pendingRegistrations?.length || 0,
                    })}</span>
                  </div>
                  {!settings?.pendingRegistrations?.length ? (
                    <div className="settings-registration-empty">
                      {t("settings.noPendingRegistrations")}
                    </div>
                  ) : (
                    settings.pendingRegistrations.map((registration) => {
                      const action = reviewingRegistration?.username === registration.username
                        ? reviewingRegistration.action
                        : null;
                      return (
                        <div key={registration.username} className="settings-user-row">
                          <div className="settings-user-info">
                            <div className="settings-user-name-row">
                              <span className="settings-user-name">{registration.username}</span>
                              <span className="settings-role-badge pending">
                                {t("settings.pendingApproval")}
                              </span>
                            </div>
                            <div className="settings-user-path">
                              {t("settings.requestedAt", {
                                time: new Date(registration.requestedAt).toLocaleString(
                                  locale === "zh-CN" ? "zh-CN" : "en-US"
                                ),
                              })}
                            </div>
                          </div>
                          <div className="settings-user-actions">
                            <button
                              type="button"
                              className="settings-inline-btn approve"
                              disabled={Boolean(reviewingRegistration)}
                              onClick={() => void handleApproveRegistration(registration.username)}
                            >
                              <Check size={14} />
                              {action === "approve"
                                ? t("settings.approvingRegistration")
                                : t("settings.approveRegistration")}
                            </button>
                            <button
                              type="button"
                              className="settings-inline-btn danger"
                              disabled={Boolean(reviewingRegistration)}
                              onClick={() => { setError(null); setConfirmation({ kind: "reject-registration", username: registration.username }); }}
                            >
                              <X size={14} />
                              {action === "reject"
                                ? t("settings.rejectingRegistration")
                                : t("settings.rejectRegistration")}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
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
                            setError(null);
                            setPasswordTarget(user);
                            setNextPassword("");
                          }}
                        >
                          <KeyRound size={14} />
                          {t("settings.changePassword")}
                        </button>
                        <button
                          className="settings-inline-btn danger"
                          onClick={() => { setError(null); setConfirmation({ kind: "delete-user", user }); }}
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
                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.mcpAdvancedServers")}</span>
                    <textarea
                      className="settings-input"
                      rows={10}
                      value={mcpForm.serversJson}
                      onChange={(e) => setMcpForm((prev) => ({ ...prev, serversJson: e.target.value }))}
                      placeholder='[{"id":"local","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}]'
                      style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: "12px" }}
                    />
                    <small>{t("settings.mcpAdvancedServersHelp")}</small>
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
                            {server.disabled
                              ? t("settings.mcpServerDisabled")
                              : server.ok
                                ? t("settings.mcpServerReady")
                                : server.error || t("settings.mcpServerFailed")}
                            {!server.disabled && server.ok && server.latencyMs !== undefined
                              ? ` · ${server.latencyMs}ms${server.attempts && server.attempts > 1 ? ` · ${t("settings.mcpAttempts", { count: server.attempts })}` : ""}`
                              : ""}
                          </span>
                        </div>
                        <div className="settings-mcp-actions">
                          <span className={`settings-mcp-badge${server.disabled ? " disabled" : server.ok ? " ready" : " failed"}`}>
                            {server.disabled
                              ? t("settings.mcpServerDisabled")
                              : server.ok
                                ? t("settings.mcpToolCount", { count: server.toolCount })
                                : t("settings.mcpServerFailed")}
                          </span>
                          <button
                            className={`settings-mcp-toggle${server.disabled ? "" : " active"}`}
                            type="button"
                            aria-pressed={!server.disabled}
                            aria-label={server.disabled ? t("settings.enableMcp") : t("settings.disableMcp")}
                            title={mcpHasUnsavedChanges
                              ? t("settings.saveMcpBeforeToggle")
                              : server.disabled
                                ? t("settings.enableMcp")
                                : t("settings.disableMcp")}
                            disabled={mcpHasUnsavedChanges || togglingMcpEndpoint === server.endpointKey || savingMcp}
                            onClick={() => void handleSetMcpEnabled(server, server.disabled)}
                          >
                            <Power size={13} />
                            {togglingMcpEndpoint === server.endpointKey
                              ? t("settings.saving")
                              : server.disabled
                                ? t("settings.enableMcp")
                                : t("settings.disableMcp")}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-card-title">
                    <Shield size={16} />
                    <span>{t("settings.agentProfiles")}</span>
                  </div>
                  <span className="settings-card-meta">{t("settings.agentProfilesMeta")}</span>
                </div>
                <form className="settings-form" onSubmit={handleSaveAgentProfiles}>
                  <label className="settings-field settings-field-wide">
                    <span>{t("settings.agentProfilesJson")}</span>
                    <textarea
                      className="settings-input"
                      rows={14}
                      value={agentProfilesJson}
                      onChange={(event) => setAgentProfilesJson(event.target.value)}
                      style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: "12px" }}
                    />
                    <small>{t("settings.agentProfilesHelp")}</small>
                  </label>
                  <div className="settings-form-footer">
                    <span className="settings-help-text">{t("settings.agentProfilesHelp")}</span>
                    <button className="dialog-btn primary" type="submit" disabled={savingAgents}>
                      <Save size={14} />
                      {savingAgents ? t("settings.saving") : t("settings.saveAgentProfiles")}
                    </button>
                  </div>
                </form>
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
                  <div className="settings-model-heading">
                    <div>
                      <strong>{t("settings.endpoints")}</strong>
                      <span className="settings-help-text">{t("settings.endpointsHelp")}</span>
                    </div>
                    <button
                      className="settings-inline-btn"
                      type="button"
                      disabled={totalLlmModels >= 33}
                      onClick={() => setLlmForm((prev) => ({
                        ...prev,
                        endpoints: [...prev.endpoints, createLlmEndpoint()],
                      }))}
                    >
                      <Plus size={13} />
                      {t("settings.addEndpoint")}
                    </button>
                  </div>

                  <div className="settings-model-list">
                    {llmForm.endpoints.map((endpoint, endpointIndex) => (
                      <div className="settings-model-item" key={endpoint.id}>
                        <div className="settings-model-item-header">
                          <strong>
                            {endpointIndex === 0
                              ? t("settings.defaultEndpoint")
                              : t("settings.endpointNumber", { count: endpointIndex + 1 })}
                          </strong>
                          {endpointIndex > 0 && (
                            <button
                              className="settings-inline-btn"
                              type="button"
                              aria-label={t("settings.removeEndpoint")}
                              onClick={() => setLlmForm((prev) => ({
                                ...prev,
                                endpoints: prev.endpoints.filter((item) => item.id !== endpoint.id),
                              }))}
                            >
                              <Trash2 size={13} />
                              {t("settings.removeEndpoint")}
                            </button>
                          )}
                        </div>
                        <div className="settings-form-row">
                          <label className="settings-field">
                            <span>{t("settings.apiUrl")}</span>
                            <input
                              className="settings-input"
                              value={endpoint.apiUrl}
                              onChange={(e) => updateLlmEndpoint(endpoint.id, "apiUrl", e.target.value)}
                              placeholder="https://api.example.com/v1"
                              required
                            />
                          </label>
                          <label className="settings-field">
                            <span>{t("settings.apiKey")}</span>
                            <input
                              className="settings-input"
                              type="password"
                              value={endpoint.apiKey}
                              onChange={(e) => updateLlmEndpoint(endpoint.id, "apiKey", e.target.value)}
                              placeholder={t("settings.optionalBearerToken")}
                            />
                          </label>
                        </div>
                        <div className="settings-model-heading">
                          <strong>{t("settings.endpointModels")}</strong>
                          <button
                            className="settings-inline-btn"
                            type="button"
                            disabled={totalLlmModels >= 33}
                            onClick={() => setLlmForm((prev) => ({
                              ...prev,
                              endpoints: prev.endpoints.map((item) =>
                                item.id === endpoint.id
                                  ? { ...item, models: [...item.models, createLlmModel()] }
                                  : item
                              ),
                            }))}
                          >
                            <Plus size={13} />
                            {t("settings.addModel")}
                          </button>
                        </div>
                        {endpoint.models.map((model, modelIndex) => {
                          const isDefault = endpointIndex === 0 && modelIndex === 0;
                          return (
                            <div className="settings-endpoint-model" key={model.id}>
                              <div className="settings-model-item-header">
                                <strong>
                                  {isDefault
                                    ? t("settings.defaultModel")
                                    : model.modelName.trim() || t("settings.additionalModelNumber", { count: modelIndex + 1 })}
                                </strong>
                                <div className="settings-model-actions">
                                  {!isDefault && (
                                    <button
                                      className="settings-inline-btn"
                                      type="button"
                                      onClick={() => setDefaultLlmModel(endpoint.id, model.id)}
                                    >
                                      {t("settings.makeDefaultModel")}
                                    </button>
                                  )}
                                  {!isDefault && endpoint.models.length > 1 && (
                                    <button
                                      className="settings-inline-btn"
                                      type="button"
                                      aria-label={t("settings.removeModel", { name: model.modelName.trim() || String(modelIndex + 1) })}
                                      onClick={() => setLlmForm((prev) => ({
                                        ...prev,
                                        endpoints: prev.endpoints.map((item) =>
                                          item.id === endpoint.id
                                            ? { ...item, models: item.models.filter((entry) => entry.id !== model.id) }
                                            : item
                                        ),
                                      }))}
                                    >
                                      <Trash2 size={13} />
                                      {t("settings.removeModelButton")}
                                    </button>
                                  )}
                                </div>
                              </div>
                              <label className="settings-field">
                                <span>{t("settings.modelName")}</span>
                                <input
                                  className="settings-input"
                                  value={model.modelName}
                                  onChange={(e) => updateLlmModel(endpoint.id, model.id, "modelName", e.target.value)}
                                  placeholder="model-name"
                                  required
                                />
                              </label>
                              <div className="settings-parameters-grid">
                                {LLM_PARAMETER_INPUTS.map(({ field, min, max, step }) => (
                                  <label className="settings-field" key={field}>
                                    <span>{t("settings." + field)}</span>
                                    <input
                                      className="settings-input"
                                      type="number"
                                      min={min}
                                      max={max}
                                      step={step}
                                      value={model[field]}
                                      onChange={(e) => updateLlmModel(endpoint.id, model.id, field, e.target.value)}
                                      placeholder={isDefault
                                        ? field === "maxTokens" ? "8192" : t("settings.providerDefault")
                                        : t("settings.inheritDefault")}
                                      required={isDefault && field === "maxTokens"}
                                    />
                                  </label>
                                ))}
                              </div>
                              <div className="settings-model-input-capabilities">
                                <label className="settings-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={model.supportsImageInput}
                                    onChange={(e) => updateLlmModel(endpoint.id, model.id, "supportsImageInput", e.target.checked)}
                                  />
                                  {t("settings.supportsImageInput")}
                                </label>
                                <label className="settings-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={model.supportsPdfInput}
                                    onChange={(e) => updateLlmModel(endpoint.id, model.id, "supportsPdfInput", e.target.checked)}
                                  />
                                  {t("settings.supportsPdfInput")}
                                </label>
                              </div>
                              <small className="settings-help-text">{t("settings.modelInputCapabilitiesHelp")}</small>
                              <small className="settings-help-text">
                                {isDefault
                                  ? t("settings.defaultModelParametersHelp")
                                  : t("settings.additionalModelParametersHelp")}
                              </small>
                              {isDefault && (
                                <div className="settings-model-capability">
                                  <div>
                                    <strong>{t("settings.detectedMaxTokens", { count: displayedModelCapabilities?.maxOutputTokens || "—" })}</strong>
                                    <small>
                                      {!capabilitiesMatchSavedDefault
                                        ? t("settings.saveDefaultBeforeCapabilities")
                                        : displayedModelCapabilities
                                          ? t("settings.modelCapabilitySource." + displayedModelCapabilities.source)
                                          : t("settings.modelCapabilityUnavailable")}
                                      {displayedModelCapabilities?.contextWindow
                                        ? " · " + t("settings.contextWindow", { count: displayedModelCapabilities.contextWindow })
                                        : ""}
                                    </small>
                                  </div>
                                  <button
                                    type="button"
                                    className="settings-inline-btn"
                                    onClick={() => void refreshModelCapabilities()}
                                    disabled={loadingModelCapabilities || !capabilitiesMatchSavedDefault}
                                    title={t("settings.refreshModelCapabilities")}
                                  >
                                    <RefreshCw size={13} className={loadingModelCapabilities ? "chat-spin" : ""} />
                                    {t("settings.refreshModelCapabilities")}
                                  </button>
                                  {displayedModelCapabilities?.warning && (
                                    <small className="settings-help-text">{displayedModelCapabilities.warning}</small>
                                  )}
                                  {capabilitiesMatchSavedDefault && modelCapabilityError && (
                                    <small className="settings-error-banner" role="alert">{modelCapabilityError}</small>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
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

                  <div className="settings-form-footer settings-llm-form-footer">
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
          onMouseDown={closePasswordDialog}
        >
          <div
            ref={passwordDialogRef}
            className="dialog settings-password-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-password-dialog-title"
            aria-describedby="settings-password-dialog-description"
            aria-busy={updatingPassword}
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="dialog-title" id="settings-password-dialog-title">
              {t("settings.changePasswordFor", {
                username: passwordTarget.username,
              })}
            </div>
            <p id="settings-password-dialog-description" className="sr-only">{t("settings.enterNewPassword")}</p>
            <input
              ref={passwordInputRef}
              className="dialog-input"
              type="password"
              value={nextPassword}
              onChange={(e) => setNextPassword(e.target.value)}
              placeholder={t("settings.enterNewPassword")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleUpdatePassword();
                }
              }}
            />
            {error && <div className="settings-error-banner" role="alert" aria-live="assertive">{error}</div>}
            <div className="dialog-actions">
              <button
                className="dialog-btn"
                onClick={closePasswordDialog}
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
      <ActionConfirmDialog
        intent={confirmation ? {
          id: confirmation.kind === "delete-user" ? `settings:delete-user:${confirmation.user.username}` : `settings:reject-registration:${confirmation.username}`,
          title: t("settings.confirmActionTitle"),
          description: confirmation.kind === "delete-user"
            ? t("settings.confirmDeleteUser", { username: confirmation.user.username })
            : t("settings.confirmRejectRegistration", { username: confirmation.username }),
          confirmLabel: t("common.confirm"),
          tone: "danger",
        } : null}
        busy={confirmation?.kind === "delete-user" ? deletingUsername === confirmation.user.username : confirmation?.kind === "reject-registration" ? reviewingRegistration?.username === confirmation.username && reviewingRegistration.action === "reject" : false}
        error={error}
        onClose={() => { setConfirmation(null); setError(null); }}
        onConfirm={() => {
          if (!confirmation) return;
          if (confirmation.kind === "delete-user") return handleDeleteUser(confirmation.user);
          return handleRejectRegistration(confirmation.username);
        }}
      />
    </>
  );
};
