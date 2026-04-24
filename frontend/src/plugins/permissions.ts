export const PLUGIN_PERMISSIONS = [
  "chat.render",
  "editor.setup",
  "editor.mount",
  "editor.preview",
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
