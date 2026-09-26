import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { derivePluginScopes } from "../permissions";
import type { BuiltinPluginDefinition } from "../types";

const permissions = ["chat.render", "editor.preview"] as const;

export const markdownRendererPlugin: BuiltinPluginDefinition = {
  manifest: {
    id: "builtin.chat-markdown",
    name: "Chat & Editor Markdown Renderer",
    version: "1.0.0",
    kind: "builtin",
    defaultEnabled: true,
    enabled: true,
    permissions: [...permissions],
    scopes: derivePluginScopes([...permissions]),
    loadable: true,
    description: "Renders Markdown in chat and provides Markdown file preview in editor.",
  },
  activate(context) {
    context.chat.registerTextRenderer({
      id: "builtin.chat-markdown.default-renderer",
      priority: -100,
      render({ content }) {
        return (
          <div className="chat-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          </div>
        );
      },
    });

    context.editor.registerPreviewRenderer({
      id: "builtin.markdown-preview.renderer",
      priority: 50,
      defaultMode: "split",
      matches({ path, language }) {
        return language === "markdown" || /\.(md|markdown|mdx)$/i.test(path);
      },
      render({ content }) {
        return (
          <div
            className="file-preview-surface chat-markdown external-markdown-preview"
            data-scroll-container="true"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          </div>
        );
      },
    });
  },
};
