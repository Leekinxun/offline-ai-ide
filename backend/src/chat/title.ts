import { config } from "../config.js";
import { callChatCompletion } from "../agent/llm.js";
import type { OpenAIResponse } from "../agent/types.js";

function sanitizeGeneratedTitle(value: string): string {
  return value
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

export async function generateConversationTitle(
  userMessage: string
): Promise<string | null> {
  const prompt = userMessage.trim();
  if (!prompt) {
    return null;
  }

  const response = await callChatCompletion({
    apiUrl: config.vllmApiUrl,
    apiKey: config.vllmApiKey,
    model: config.modelName,
    systemPrompt:
      "Generate a concise title for a coding assistant conversation. Return only the title, with no quotes, no markdown, and no explanation.",
    messages: [
      {
        role: "user",
        content:
          `User request:\n${prompt}\n\n` +
          "Write a short conversation title in 3 to 8 words.",
      },
    ],
    maxTokens: 24,
    temperature: 0.2,
    stream: false,
  });

  if (!response.ok) {
    return null;
  }

  let payload: OpenAIResponse;
  try {
    payload = (await response.json()) as OpenAIResponse;
  } catch {
    return null;
  }

  const rawTitle = payload.choices?.[0]?.message?.content || "";
  const title = sanitizeGeneratedTitle(rawTitle);
  return title || null;
}
