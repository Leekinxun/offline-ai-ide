import fs from "fs";
import path from "path";
import { config, getPluginOverrides } from "../config.js";
import {
  derivePluginScopes,
  parsePluginPermissions,
  type PluginPermission,
  type PluginScope,
} from "./permissions.js";

interface PluginManifestFile {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  entry?: unknown;
  permissions?: unknown;
  description?: unknown;
  author?: unknown;
  enabled?: unknown;
}

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
}

interface DiscoveredPlugin extends ExternalPluginManifest {
  rootDir: string;
}

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

function discoverPlugin(pluginDir: string): DiscoveredPlugin | null {
  const directoryName = path.basename(pluginDir);
  const directoryPath = path.resolve(pluginDir);
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
    rootDir: directoryPath,
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

  const entryPath = path.resolve(pluginDir, entry);
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

  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    console.warn(`Skipping plugin ${manifest.id}: entry file not found`);
    return {
      ...basePlugin,
      validationError: `Entry file "${entry}" was not found`,
    };
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

export function listExternalPlugins(): ExternalPluginManifest[] {
  return discoverPlugins().map(({ rootDir: _rootDir, ...plugin }) => plugin);
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

  return fullPath;
}
