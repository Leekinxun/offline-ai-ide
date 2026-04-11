import path from "path";
import os from "os";
import fs from "fs";

function resolveWorkspaceDir(): string {
  const envDir = process.env.WORKSPACE_DIR;
  if (envDir) return path.resolve(envDir);

  // Try /workspace (works inside Docker)
  try {
    fs.mkdirSync("/workspace", { recursive: true });
    return "/workspace";
  } catch {
    // Fallback for macOS/local dev
    const fallback = path.join(os.homedir(), "ai-ide-workspace");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export const config = {
  port: parseInt(process.env.PORT || "3000"),
  workspaceDir: resolveWorkspaceDir(),
  vllmApiUrl: process.env.VLLM_API_URL || "http://host.docker.internal:8000/v1",
  vllmApiKey: process.env.VLLM_API_KEY || "",
  modelName: process.env.MODEL_NAME || "default",
  staticDir: process.env.STATIC_DIR || "static",
  maxAgentIterations: parseInt(process.env.MAX_AGENT_ITERATIONS || "30"),
  agentMaxTokens: parseInt(process.env.AGENT_MAX_TOKENS || "8192"),
};
