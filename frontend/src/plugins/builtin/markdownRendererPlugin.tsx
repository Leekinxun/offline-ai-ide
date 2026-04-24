import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { derivePluginScopes } from "../permissions";
import type { BuiltinPluginDefinition } from "../types";

const permissions = ["chat.render"] as const;

export const markdownRendererPlugin: BuiltinPluginDefinition = {
  manifest: {
    id: "builtin.chat-markdown",
    name: "Chat Markdown Renderer",
    version: "1.0.0",
    kind: "builtin",
    defaultEnabled: true,
    enabled: true,
    permissions: [...permissions],
    scopes: derivePluginScopes([...permissions]),
    loadable: true,
    description: "Renders assistant and user text fragments as GitHub-flavored Markdown.",
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
  },
};
