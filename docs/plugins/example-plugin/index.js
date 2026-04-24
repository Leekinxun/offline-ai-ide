export default function activate(api) {
  api.chat.registerTextRenderer({
    id: "example.note-blocks.renderer",
    priority: 200,
    render({ content, React }) {
      const marker = ":::note";
      if (!content.includes(marker)) {
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

  api.commands.registerCommand({
    id: "example.note-blocks.show-plugin-info",
    title: "Example: Show Plugin Info",
    description: "Logs the plugin scopes and permissions.",
    run() {
      api.logger.info("Plugin info", api.plugin);
    },
  });

  api.editor.registerMountHandler(({ editor, path }) => {
    const disposable = editor.addAction({
      id: "example.note-blocks.show-file-path",
      label: "Example Plugin: Show Current File Path",
      run: () => {
        api.logger.info(`Current file: ${path}`);
      },
    });

    return () => disposable.dispose();
  });
}
