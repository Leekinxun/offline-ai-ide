# Plugin System

This project now supports a lightweight plugin mode inspired by VS Code, with two plugin sources:

- Builtin plugins: shipped with the frontend bundle and activated automatically
- External plugins: discovered from the local `plugins/` directory and loaded at runtime

## Current extension points

The first phase keeps the surface area intentionally small and stable:

- `editor.registerSetup(handler)`
  - Runs once during frontend bootstrap
  - Intended for Monaco-wide registration such as themes, languages, token providers
- `editor.registerMountHandler(handler)`
  - Runs every time an editor instance is mounted
  - Intended for editor actions, commands, decorations, listeners
- `chat.registerTextRenderer(renderer)`
  - Renders non-code message fragments in the chat panel
  - Higher `priority` wins, so custom renderers can override the builtin Markdown renderer
- `ui.registerLocaleBundle(bundle)`
  - Registers UI translation messages for one locale
  - Bundles are merged by locale, so multiple plugins can contribute messages incrementally

## Builtin plugins

The existing capabilities were moved behind builtin plugins:

- `builtin.ui-localization`
  - Registers English and Simplified Chinese UI message bundles
- `builtin.monaco-highlighting`
  - Registers editor theme, component language support, and semantic highlighting providers
- `builtin.chat-markdown`
  - Renders chat text with `react-markdown` and `remark-gfm`

Builtin plugin entry files live under `frontend/src/plugins/builtin/`.

## External plugin layout

External plugins are loaded from the local `plugins/` directory at the project root by default.
You can override the directory with `PLUGINS_DIR`.

Each plugin is a folder containing a manifest and an ES module entry:

```text
plugins/
  your-plugin/
    plugin.json
    index.js
    helper.js
    assets/
```

Example `plugin.json`:

```json
{
  "id": "acme.note-blocks",
  "name": "ACME Note Blocks",
  "version": "1.0.0",
  "permissions": ["chat.render", "command.register"],
  "description": "Adds a custom chat renderer for :::note blocks.",
  "entry": "index.js"
}
```

Required manifest fields:

- `id`
- `name`
- `version`
- `entry`
- `permissions`

Optional fields:

- `description`
- `author`
- `enabled`

## Permissions and scopes

Plugins must explicitly declare the capabilities they need in `permissions`.
The host validates these permissions before loading the plugin, and the runtime rejects calls to undeclared host APIs.

Current permissions:

- `chat.render`
  - Scope: `chat`
  - Allows `api.chat.registerTextRenderer(...)`
- `editor.setup`
  - Scope: `editor`
  - Allows `api.editor.registerSetup(...)`
- `editor.mount`
  - Scope: `editor`
  - Allows `api.editor.registerMountHandler(...)`
- `command.register`
  - Scope: `command`
  - Allows `api.commands.registerCommand(...)`
- `ui.messages`
  - Scope: `ui`
  - Allows `api.ui.registerLocaleBundle(...)`

Scopes are derived from permissions and shown in the plugin manager UI.

## External plugin entry contract

The plugin entry must export either:

- a default function `activate(api)`
- or an object with `activate(api)`

Example:

```js
export default function activate(api) {
  api.chat.registerTextRenderer({
    id: "acme.note-blocks.renderer",
    priority: 200,
    render({ content, React }) {
      if (!content.includes(":::note")) {
        return null;
      }

      const text = content.replace(/:::note\s*/g, "").trim();

      return React.createElement(
        "div",
        {
          className: "chat-markdown",
          style: {
            borderLeft: "3px solid #0f5cc0",
            paddingLeft: "12px",
          },
        },
        React.createElement("strong", null, "Note"),
        React.createElement("div", null, text)
      );
    },
  });
}
```

### `api` fields

- `api.React`
- `api.monaco`
- `api.logger`
- `api.plugin`
- `api.chat.registerTextRenderer(renderer)`
- `api.editor.registerSetup(handler)`
- `api.editor.registerMountHandler(handler)`
- `api.commands.registerCommand(command)`
- `api.ui.registerLocaleBundle(bundle)`

Example command registration:

```js
api.commands.registerCommand({
  id: "acme.note-blocks.say-hello",
  title: "ACME: Say Hello",
  description: "Simple example command",
  run() {
    api.logger.info("Hello from ACME Note Blocks");
  },
});
```

Commands registered by plugins are visible in the plugin manager and can be executed there.

Example locale registration:

```js
api.ui.registerLocaleBundle({
  locale: "zh-CN",
  label: "简体中文",
  messages: {
    "example.hello": "你好，插件世界",
  },
});
```

## Offline installation

1. Copy a plugin folder into `plugins/`
2. Refresh the IDE page
3. The frontend requests `/api/plugins` and loads the plugin entry from `/api/plugins/assets/...`

No package registry or network install step is required.

## Enable / disable plugins

- Plugin enable state is persisted in `app-settings.json`
- The saved state is a host-level override and does not modify the plugin's own `plugin.json`
- Changes are applied on the next app reload
- You can also restore the default plugin behavior by removing the override from the settings UI

This is intentional: some plugin contributions, especially Monaco-wide registrations, are not safely hot-unloadable during a live session.

## Trust boundary

External plugins execute as frontend code in the same browser context as the IDE.
Treat plugins as trusted code and only install plugins from sources you trust.

## Example template

A copyable external plugin template is included at:

- `docs/plugins/example-plugin/`
