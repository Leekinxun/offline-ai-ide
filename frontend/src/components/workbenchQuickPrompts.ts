import type { AgentMode } from "../types";

export type WorkbenchQuickPromptId = "inspect" | "plan" | "fix" | "test";

export interface WorkbenchQuickPromptDefinition {
  id: WorkbenchQuickPromptId;
  mode: AgentMode;
  labelKey: `workbench.quickPrompt.${WorkbenchQuickPromptId}`;
  promptKey: `workbench.quickPrompt.${WorkbenchQuickPromptId}Text`;
}

export const CHAT_EMPTY_QUICK_PROMPTS: WorkbenchQuickPromptDefinition[] = [
  { id: "inspect", mode: "ask", labelKey: "workbench.quickPrompt.inspect", promptKey: "workbench.quickPrompt.inspectText" },
  { id: "plan", mode: "plan", labelKey: "workbench.quickPrompt.plan", promptKey: "workbench.quickPrompt.planText" },
  { id: "fix", mode: "code", labelKey: "workbench.quickPrompt.fix", promptKey: "workbench.quickPrompt.fixText" },
  { id: "test", mode: "review", labelKey: "workbench.quickPrompt.test", promptKey: "workbench.quickPrompt.testText" },
];

export function quickPromptDefinition(id: WorkbenchQuickPromptId): WorkbenchQuickPromptDefinition {
  const definition = CHAT_EMPTY_QUICK_PROMPTS.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown quick prompt: ${id}`);
  return definition;
}

export function resolveQuickPromptCopy(
  messages: Record<string, string>,
  id: WorkbenchQuickPromptId
): { label: string; prompt: string; mode: AgentMode } {
  const definition = quickPromptDefinition(id);
  return {
    label: messages[definition.labelKey] || definition.labelKey,
    prompt: messages[definition.promptKey] || definition.promptKey,
    mode: definition.mode,
  };
}
