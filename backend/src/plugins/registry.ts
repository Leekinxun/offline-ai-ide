import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { config, getPluginOverrides } from "../config.js";
import {
  derivePluginScopes,
  parsePluginPermissions,
  type PluginPermission,
  type PluginScope,
} from "./permissions.js";
import { getAgentHooksGeneration, registerDeclarativeAgentHook } from "../agent/agentHooks.js";
import { getMcpClient } from "../agent/mcp.js";
import { intersectSandboxGrants, validateHookDeclaration } from "../extensions/policy/evaluator.js";
import { ExtensionPolicyStore } from "../extensions/policy/store.js";
import type { ExtensionHookDeclaration, PermissionLayer, SandboxGrant } from "../extensions/policy/types.js";

interface PluginManifestFile {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  entry?: unknown;
  permissions?: unknown;
  description?: unknown;
  author?: unknown;
  enabled?: unknown;
  signature?: unknown;
  hooks?: unknown;
  profiles?: unknown;
  skills?: unknown;
  sandbox?: unknown;
}

export interface PluginManifestSignature { algorithm: "ed25519"; keyId: string; value: string; }

export interface ExternalPluginManifest {
  id: string;
  name: string;
  version: string;
  defaultEnabled: boolean;
  enabled: boolean;
  permissions: PluginPermission[];
  scopes: PluginScope[];
  loadable: boolean;
  entry?: string;
  entryUrl?: string;
  assetBaseUrl?: string;
  description?: string;
  author?: string;
  directoryName: string;
  directoryPath: string;
  validationError?: string;
  kind: "external";
  signatureStatus: "verified" | "invalid" | "legacy-restricted";
  signingKeyId?: string;
  hooks: Array<{ id: string; event: string; failureMode: "open" | "closed"; blocksCompletion: boolean; profileId?: string; skillIds: string[] }>;
  profiles: string[];
  skills: string[];
}

interface DiscoveredPlugin extends ExternalPluginManifest {
  rootDir: string;
  runtime?: PluginRuntime;
}

interface RuntimeLayer { layer: PermissionLayer; sandbox: SandboxGrant; }
interface RuntimeHook { id: string; declaration: ExtensionHookDeclaration; profileId?: string; skillIds: string[]; }
interface PluginRuntime { manifestLayer: PermissionLayer; sandbox: SandboxGrant; profiles: Map<string, RuntimeLayer>; skills: Map<string, RuntimeLayer>; hooks: RuntimeHook[]; }

const MANIFEST_FILE = "plugin.json";
const VALID_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ManifestReadResult {
  manifest: PluginManifestFile | null;
  error?: string;
}

function normalizeRelativeAssetPath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    return null;
  }
  return normalized;
}

function toAssetUrl(pluginId: string, assetPath: string): string {
  const encodedPluginId = encodeURIComponent(pluginId);
  const encodedAssetPath = assetPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/plugins/assets/${encodedPluginId}/${encodedAssetPath}`;
}

function readManifest(pluginDir: string): ManifestReadResult {
  const manifestPath = path.join(pluginDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return {
      manifest: null,
      error: `Missing ${MANIFEST_FILE}`,
    };
  }

  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    return {
      manifest: JSON.parse(raw) as PluginManifestFile,
    };
  } catch (error) {
    console.warn(`Failed to parse plugin manifest at ${manifestPath}:`, error);
    return {
      manifest: null,
      error: `Invalid ${MANIFEST_FILE}: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

function canonicalManifest(manifest: Record<string, unknown>): Buffer {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "signature").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    return value;
  };
  return Buffer.from(JSON.stringify(normalize(manifest)), "utf8");
}

export function verifyPluginManifestSignature(
  manifest: Record<string, unknown>,
  trustedKeys: Record<string, string>
): { status: "verified" | "invalid" | "legacy-restricted"; keyId?: string; error?: string } {
  if (!manifest.signature) return { status: "legacy-restricted", error: "Unsigned legacy manifest is restricted to its declared UI capabilities" };
  const signature = manifest.signature as Partial<PluginManifestSignature>;
  if (signature.algorithm !== "ed25519" || typeof signature.keyId !== "string" || typeof signature.value !== "string") return { status: "invalid", error: "Invalid plugin signature metadata" };
  const publicKey = trustedKeys[signature.keyId];
  if (!publicKey) return { status: "invalid", keyId: signature.keyId, error: "Plugin signing key is not trusted" };
  try {
    const valid = crypto.verify(null, canonicalManifest(manifest), publicKey, Buffer.from(signature.value, "base64"));
    return valid ? { status: "verified", keyId: signature.keyId } : { status: "invalid", keyId: signature.keyId, error: "Plugin signature verification failed" };
  } catch { return { status: "invalid", keyId: signature.keyId, error: "Plugin signature verification failed" }; }
}

function trustedPluginKeys(): Record<string, string> {
  try {
    const parsed = JSON.parse(process.env.CREWFORGE_PLUGIN_TRUST_KEYS || "{}");
    const configured = parsed && typeof parsed === "object" ? parsed : {};
    const admin = new ExtensionPolicyStore(config.defaultWorkspaceDir).getAdminPolicy().trustedSigningKeys || {};
    return { ...configured, ...admin };
  }
  catch { return {}; }
}

function stringList(value: unknown): string[] {
  return Array.from(new Set((Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))).sort();
}

function sandboxGrant(value: unknown): SandboxGrant {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { readPaths: stringList(raw.readPaths), writePaths: stringList(raw.writePaths), networkOrigins: stringList(raw.networkOrigins), secretEnv: stringList(raw.secretEnv) };
}

function runtimeLayer(value: unknown, id: string, manifestPermissions: string[]): RuntimeLayer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allow = stringList((raw.permissions as Record<string, unknown> | undefined)?.allow ?? raw.allow);
  const deny = stringList((raw.permissions as Record<string, unknown> | undefined)?.deny ?? raw.deny);
  if (allow.some((permission) => !manifestPermissions.includes(permission))) return null;
  return { layer: { id, allow, deny, signed: true }, sandbox: sandboxGrant(raw.sandbox) };
}

function parsePluginRuntime(manifest: PluginManifestFile, pluginId: string, permissions: PluginPermission[]): { runtime?: PluginRuntime; error?: string } {
  const manifestPermissions = permissions as string[];
  const manifestLayer: PermissionLayer = { id: `plugin:${pluginId}`, allow: [...manifestPermissions], deny: [], signed: true };
  const profiles = new Map<string, RuntimeLayer>();
  for (const item of Array.isArray(manifest.profiles) ? manifest.profiles : []) {
    const raw = item as Record<string, unknown>; const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const layer = id ? runtimeLayer(raw, `plugin:${pluginId}:profile:${id}`, manifestPermissions) : null;
    if (!id || !layer || profiles.has(id)) return { error: "Invalid or escalating plugin profile layer" };
    profiles.set(id, layer);
  }
  const skills = new Map<string, RuntimeLayer>();
  for (const item of Array.isArray(manifest.skills) ? manifest.skills : []) {
    const raw = item as Record<string, unknown>; const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const layer = id ? runtimeLayer(raw, `plugin:${pluginId}:skill:${id}`, manifestPermissions) : null;
    if (!id || !layer || skills.has(id)) return { error: "Invalid or escalating plugin skill layer" };
    skills.set(id, layer);
  }
  const hooks: RuntimeHook[] = [];
  for (const item of Array.isArray(manifest.hooks) ? manifest.hooks : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "Invalid plugin hook declaration" };
    const raw = item as Record<string, unknown>;
    const profileId = typeof raw.profileId === "string" ? raw.profileId.trim() : undefined;
    const skillIds = stringList(raw.skillIds);
    if (profileId && !profiles.has(profileId)) return { error: `Unknown plugin hook profile: ${profileId}` };
    if (skillIds.some((id) => !skills.has(id))) return { error: "Unknown plugin hook skill layer" };
    const localId = typeof raw.id === "string" ? raw.id.trim() : "";
    const declaration = { ...raw, id: localId, permissions: stringList(raw.permissions), sandbox: sandboxGrant(raw.sandbox) } as unknown as ExtensionHookDeclaration;
    if (declaration.permissions.some((permission) => !manifestPermissions.includes(permission))) return { error: "Plugin hook permissions exceed signed manifest" };
    try { validateHookDeclaration(declaration); } catch (error) { return { error: error instanceof Error ? error.message : "Invalid plugin hook declaration" }; }
    hooks.push({ id: localId, declaration: { ...declaration, id: `${pluginId}.${localId}` }, ...(profileId ? { profileId } : {}), skillIds });
  }
  return { runtime: { manifestLayer, sandbox: sandboxGrant(manifest.sandbox), profiles, skills, hooks } };
}

function discoverPlugin(pluginDir: string): DiscoveredPlugin | null {
  const directoryName = path.basename(pluginDir);
  const directoryPath = fs.realpathSync.native(path.resolve(pluginDir));
  const { manifest, error } = readManifest(pluginDir);
  const pluginOverrides = getPluginOverrides();
  const pluginIdFromManifest =
    manifest && typeof manifest.id === "string" && manifest.id.trim()
      ? manifest.id.trim()
      : directoryName;
  const overrideEnabled = pluginOverrides[pluginIdFromManifest]?.enabled;
  const defaultEnabled = manifest?.enabled !== false;
  const parsedPermissions = parsePluginPermissions(manifest?.permissions);
  const permissions = parsedPermissions.permissions;
  const scopes = derivePluginScopes(permissions);
  const signature = manifest ? verifyPluginManifestSignature(manifest as Record<string, unknown>, trustedPluginKeys()) : { status: "invalid" as const, error: "Manifest unavailable" };
  const parsedRuntime = manifest && signature.status === "verified" ? parsePluginRuntime(manifest, pluginIdFromManifest, permissions) : {};

  const basePlugin: DiscoveredPlugin = {
    id: pluginIdFromManifest,
    name:
      manifest && typeof manifest.name === "string" && manifest.name.trim()
        ? manifest.name.trim()
        : directoryName,
    version:
      manifest && typeof manifest.version === "string" && manifest.version.trim()
        ? manifest.version.trim()
        : "unknown",
    defaultEnabled,
    enabled: typeof overrideEnabled === "boolean" ? overrideEnabled : defaultEnabled,
    permissions,
    scopes,
    loadable: false,
    entry:
      manifest && typeof manifest.entry === "string" ? manifest.entry : undefined,
    description:
      manifest && typeof manifest.description === "string"
        ? manifest.description
        : undefined,
    author:
      manifest && typeof manifest.author === "string" ? manifest.author : undefined,
    directoryName,
    directoryPath,
    validationError: error || parsedPermissions.error,
    kind: "external",
    signatureStatus: signature.status,
    ...(signature.keyId ? { signingKeyId: signature.keyId } : {}),
    hooks: parsedRuntime.runtime?.hooks.map((hook) => ({ id: hook.id, event: hook.declaration.event, failureMode: hook.declaration.failureMode, blocksCompletion: Boolean(hook.declaration.blocksCompletion), profileId: hook.profileId, skillIds: hook.skillIds })) || [],
    profiles: [...(parsedRuntime.runtime?.profiles.keys() || [])],
    skills: [...(parsedRuntime.runtime?.skills.keys() || [])],
    rootDir: directoryPath,
    runtime: parsedRuntime.runtime,
  };

  if (!manifest) {
    return basePlugin;
  }

  if (
    typeof manifest.id !== "string" ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    typeof manifest.entry !== "string"
  ) {
    console.warn(`Skipping plugin in ${pluginDir}: invalid required fields`);
    return {
      ...basePlugin,
      validationError:
        "Invalid plugin.json: id, name, version, and entry must be strings",
    };
  }

  if (parsedPermissions.error) {
    console.warn(`Skipping plugin ${pluginIdFromManifest}: ${parsedPermissions.error}`);
    return {
      ...basePlugin,
      validationError: parsedPermissions.error,
    };
  }

  if (signature.status === "legacy-restricted" && permissions.some((permission) => permission.startsWith("hook.") || permission.startsWith("agent.") || permission.startsWith("memory."))) {
    return { ...basePlugin, validationError: "Unsigned legacy plugins cannot request agent extension permissions" };
  }

  if (signature.status === "invalid") {
    return { ...basePlugin, validationError: signature.error || "Invalid plugin signature" };
  }

  if (parsedRuntime.error) return { ...basePlugin, validationError: parsedRuntime.error };

  if (!VALID_PLUGIN_ID.test(manifest.id)) {
    console.warn(`Skipping plugin in ${pluginDir}: invalid plugin id "${manifest.id}"`);
    return {
      ...basePlugin,
      validationError: `Invalid plugin id "${manifest.id}"`,
    };
  }

  const entry = normalizeRelativeAssetPath(manifest.entry);
  if (!entry) {
    console.warn(`Skipping plugin ${manifest.id}: invalid entry path "${manifest.entry}"`);
    return {
      ...basePlugin,
      validationError: `Invalid entry path "${manifest.entry}"`,
    };
  }

  const entryPath = path.resolve(directoryPath, entry);
  if (
    !entryPath.startsWith(`${directoryPath}${path.sep}`) &&
    entryPath !== directoryPath
  ) {
    console.warn(`Skipping plugin ${manifest.id}: entry escapes plugin directory`);
    return {
      ...basePlugin,
      validationError: "Entry path escapes plugin directory",
    };
  }

  if (!fs.existsSync(entryPath) || fs.lstatSync(entryPath).isSymbolicLink() || !fs.statSync(entryPath).isFile()) {
    console.warn(`Skipping plugin ${manifest.id}: entry file not found`);
    return {
      ...basePlugin,
      validationError: `Entry file "${entry}" was not found`,
    };
  }
  const canonicalEntry = fs.realpathSync.native(entryPath);
  if (!canonicalEntry.startsWith(`${directoryPath}${path.sep}`)) {
    return { ...basePlugin, validationError: "Entry path resolves outside plugin directory" };
  }

  return {
    ...basePlugin,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    entry,
    entryUrl: toAssetUrl(manifest.id, entry),
    assetBaseUrl: `/api/plugins/assets/${encodeURIComponent(manifest.id)}/`,
    loadable: true,
    validationError: undefined,
  };
}

function discoverPlugins(): DiscoveredPlugin[] {
  const pluginsDir = path.resolve(config.pluginsDir);
  fs.mkdirSync(pluginsDir, { recursive: true });

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch (error) {
    console.warn(`Failed to read plugins directory ${pluginsDir}:`, error);
    return [];
  }

  const seenIds = new Set<string>();
  const plugins: DiscoveredPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const plugin = discoverPlugin(path.join(pluginsDir, entry.name));
    if (!plugin) continue;

    if (seenIds.has(plugin.id)) {
      console.warn(`Skipping duplicate plugin id "${plugin.id}"`);
      plugins.push({
        ...plugin,
        id: `${plugin.id}@${entry.name}`,
        loadable: false,
        validationError: `Duplicate plugin id "${plugin.id}"`,
      });
      continue;
    }

    seenIds.add(plugin.id);
    plugins.push(plugin);
  }

  return plugins.sort((left, right) => left.name.localeCompare(right.name));
}

const registeredHookUnsubscribers: Array<() => void> = [];
const signedRuntimePlugins = new Map<string, PluginRuntime>();
let runtimeFingerprint = "";
let runtimeHookGeneration = -1;

function pluginRuntimeFingerprint(plugins: DiscoveredPlugin[]): string {
  const data = plugins.map((plugin) => ({
    id: plugin.id, version: plugin.version, enabled: plugin.enabled, loadable: plugin.loadable, signatureStatus: plugin.signatureStatus,
    permissions: plugin.permissions, hooks: plugin.runtime?.hooks.map((hook) => ({ id: hook.id, declaration: hook.declaration, profileId: hook.profileId, skillIds: hook.skillIds })) || [],
    profiles: plugin.runtime ? [...plugin.runtime.profiles.entries()] : [], skills: plugin.runtime ? [...plugin.runtime.skills.entries()] : [],
  }));
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function replaceRuntimeRegistrations(plugins: DiscoveredPlugin[]): void {
  const fingerprint = pluginRuntimeFingerprint(plugins);
  if (fingerprint === runtimeFingerprint && runtimeHookGeneration === getAgentHooksGeneration()) return;
  registeredHookUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  signedRuntimePlugins.clear();
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.loadable || plugin.signatureStatus !== "verified" || !plugin.runtime) continue;
    signedRuntimePlugins.set(plugin.id, plugin.runtime);
    for (const hook of plugin.runtime.hooks) {
      registeredHookUnsubscribers.push(registerDeclarativeAgentHook(hook.declaration, { resolve: (context) => {
        const workspaceDir = context.workspaceDir || String(context.metadata?.workspaceDir || "");
        if (!workspaceDir) throw new Error("Plugin hook policy requires a workspace");
        const store = new ExtensionPolicyStore(workspaceDir); const admin = store.getAdminPolicy(); const workspace = store.getWorkspaceOverride();
        const profile = hook.profileId ? plugin.runtime!.profiles.get(hook.profileId) : undefined;
        const skills = hook.skillIds.map((id) => plugin.runtime!.skills.get(id)!);
        const hookLayer: PermissionLayer = { id: `hook:${hook.declaration.id}`, allow: [...hook.declaration.permissions], deny: [], signed: true };
        const sandboxLayers = [admin.sandbox, plugin.runtime!.sandbox, ...(profile ? [profile.sandbox] : []), ...skills.map((skill) => skill.sandbox), hook.declaration.sandbox, workspace.sandbox];
        const effectiveSandbox = intersectSandboxGrants(sandboxLayers);
        return {
          permissionLayers: [admin.permissions, plugin.runtime!.manifestLayer, ...(profile ? [profile.layer] : []), ...skills.map((skill) => skill.layer), hookLayer, workspace.permissions],
          sandboxLayers,
          adapters: {
            mcp: ({ serverId, toolName, arguments: arguments_, signal }) => getMcpClient().callConfiguredTool(serverId, toolName, arguments_, {
              networkOrigins: effectiveSandbox.networkOrigins || [],
              secretEnv: effectiveSandbox.secretEnv || [],
              signal,
            }),
          },
        };
      } }));
    }
  }
  runtimeFingerprint = fingerprint;
  runtimeHookGeneration = getAgentHooksGeneration();
}

export function reloadExternalPlugins(): ExternalPluginManifest[] {
  const plugins = discoverPlugins(); replaceRuntimeRegistrations(plugins);
  return plugins.map(({ rootDir: _rootDir, runtime: _runtime, ...plugin }) => plugin);
}

export function resolveRegisteredPluginPolicy(input: { pluginId: string; profileId?: string; skillIds?: string[]; hookId?: string }): { layers: PermissionLayer[]; sandbox: SandboxGrant[] } | null {
  const runtime = signedRuntimePlugins.get(input.pluginId); if (!runtime) return null;
  const profile = input.profileId ? runtime.profiles.get(input.profileId) : undefined;
  if (input.profileId && !profile) return null;
  const skills = (input.skillIds || []).map((id) => runtime.skills.get(id)); if (skills.some((item) => !item)) return null;
  const hook = input.hookId ? runtime.hooks.find((item) => item.id === input.hookId || item.declaration.id === input.hookId) : undefined;
  if (input.hookId && !hook) return null;
  return { layers: [runtime.manifestLayer, ...(profile ? [profile.layer] : []), ...skills.map((item) => item!.layer), ...(hook ? [{ id: `hook:${input.pluginId}:${hook.id}`, allow: hook.declaration.permissions, deny: [], signed: true } satisfies PermissionLayer] : [])], sandbox: [runtime.sandbox, ...(profile ? [profile.sandbox] : []), ...skills.map((item) => item!.sandbox), ...(hook ? [hook.declaration.sandbox] : [])] };
}

export function listExternalPlugins(): ExternalPluginManifest[] {
  return reloadExternalPlugins();
}

export function resolveExternalPluginAsset(
  pluginId: string,
  assetPath: string
): string | null {
  const plugin = discoverPlugins().find((item) => item.id === pluginId);
  if (!plugin) return null;

  const normalizedAssetPath = normalizeRelativeAssetPath(assetPath);
  if (!normalizedAssetPath) return null;

  const fullPath = path.resolve(plugin.rootDir, normalizedAssetPath);
  if (
    fullPath !== plugin.rootDir &&
    !fullPath.startsWith(`${plugin.rootDir}${path.sep}`)
  ) {
    return null;
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return null;
  }

  try {
    if (fs.lstatSync(fullPath).isSymbolicLink() || !fs.realpathSync.native(fullPath).startsWith(`${plugin.rootDir}${path.sep}`)) return null;
  } catch { return null; }

  return fullPath;
}
