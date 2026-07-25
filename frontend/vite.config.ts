import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function createWorkbenchChunk(id: string): string | undefined {
  if (id.includes("vite/preload-helper")) return "app-runtime";
  if (!id.includes("node_modules")) return undefined;

  if (id.includes("/@monaco-editor/react/")) return "monaco-react";
  if (id.includes("/monaco-editor/")) return "monaco-core";
  if (id.includes("/@xterm/")) return "terminal-vendor";
  if (
    id.includes("/react-markdown/") ||
    id.includes("/remark-") ||
    id.includes("/rehype-") ||
    id.includes("/micromark") ||
    id.includes("/mdast-") ||
    id.includes("/hast-") ||
    id.includes("/unified/") ||
    id.includes("/vfile")
  ) {
    return "markdown-vendor";
  }
  if (
    id.includes("/react/") ||
    id.includes("/react-dom/") ||
    id.includes("/scheduler/")
  ) {
    return "react-vendor";
  }

  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: createWorkbenchChunk,
      },
    },
  },
});
