import { config } from "../config.js";
import { processModelTurn } from "../agent/modelProcessor.js";
import { bindConfiguredFallbacks, buildProviderExecutionContract } from "../agent/providerRouting.js";

function sanitizeGeneratedTitle(value: string): string {
  return value
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

export async function generateConversationTitle(
  userMessage: string,
  context: { workspaceDir: string; conversationId: string; requestId?: string }
): Promise<string | null> {
  const prompt = userMessage.trim();
  if (!prompt) {
    return null;
  }

  try {
    const executionContract = buildProviderExecutionContract({ id: "title:read-only", permissions: [], isolation: "workspace:read-only", tools: [] });
    const processed = await processModelTurn({
      apiUrl: config.vllmApiUrl,
      apiKey: config.vllmApiKey,
      model: config.modelName,
      executionContract,
      fallbacks: bindConfiguredFallbacks(config.modelFallbacks, executionContract, 24),
      systemPrompt: "Generate a concise title for a coding assistant conversation. Return only the title, with no quotes, no markdown, and no explanation.",
      messages: [{ role: "user", content: `User request:\n${prompt}\n\nWrite a short conversation title in 3 to 8 words.` }],
      fallbackMaxOutputTokens: 24,
      maxOutputTokens: 24,
      temperature: 0.2,
      maxAttempts: 1,
      contextAudit: {
        storeWorkspaceDir: context.workspaceDir,
        scope: { kind: "workspace", scopeId: "workspace" },
        purpose: "title",
        conversationId: context.conversationId,
        requestId: context.requestId,
        agentId: "title-generator",
        systemPromptSources: [{ kind: "system_instruction", sourceType: "title_runtime", reason: "Server-owned title generation instruction", trust: "platform", integrity: "verified_digest", freshness: "fresh" }],
        messageSources: [{ kind: "title_input", sourceType: "user_message", reason: "Initial user request used to label the conversation", trust: "authenticated_user", integrity: "observed", freshness: "fresh" }],
      },
    });
    const rawTitle = processed.response.choices?.[0]?.message?.content || "";
    const title = sanitizeGeneratedTitle(rawTitle);
    return title || null;
  } catch {
    return null;
  }
}
