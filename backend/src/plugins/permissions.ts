export const PLUGIN_PERMISSIONS = [
  "chat.render",
  "editor.setup",
  "editor.mount",
  "command.register",
  "ui.messages",
] as const;

export const PLUGIN_SCOPES = [
  "chat",
  "editor",
  "command",
  "ui",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

const VALID_PLUGIN_PERMISSIONS = new Set<string>(PLUGIN_PERMISSIONS);

export function isPluginPermission(value: string): value is PluginPermission {
  return VALID_PLUGIN_PERMISSIONS.has(value);
}

export function derivePluginScopes(
  permissions: PluginPermission[]
): PluginScope[] {
  const scopes = new Set<PluginScope>();

  for (const permission of permissions) {
    if (permission.startsWith("chat.")) {
      scopes.add("chat");
      continue;
    }

    if (permission.startsWith("editor.")) {
      scopes.add("editor");
      continue;
    }

    if (permission.startsWith("command.")) {
      scopes.add("command");
      continue;
    }

    if (permission.startsWith("ui.")) {
      scopes.add("ui");
    }
  }

  return Array.from(scopes).sort((left, right) => left.localeCompare(right));
}

export function parsePluginPermissions(
  value: unknown
): { permissions: PluginPermission[]; error?: string } {
  if (!Array.isArray(value)) {
    return {
      permissions: [],
      error: "Invalid plugin.json: permissions must be an array of strings",
    };
  }

  const normalized: PluginPermission[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      return {
        permissions: [],
        error: "Invalid plugin.json: permissions must be an array of strings",
      };
    }

    const permission = entry.trim();
    if (!isPluginPermission(permission)) {
      return {
        permissions: [],
        error: `Unknown permission "${entry}"`,
      };
    }

    if (!seen.has(permission)) {
      seen.add(permission);
      normalized.push(permission);
    }
  }

  return {
    permissions: normalized,
  };
}
