import crypto from "node:crypto";
import path from "node:path";

export interface AgentQuestionItem {
  id: string;
  prompt: string;
  options: string[];
  multiple: boolean;
}
export interface AgentQuestion {
  id: string;
  runId: string;
  requestId: string;
  conversationId: string;
  questions: AgentQuestionItem[];
  createdAt: number;
  expiresAt: number;
}
interface PendingQuestion {
  workspace: string;
  owner: string;
  question: AgentQuestion;
  finish: (result: string) => void;
}
const pending = new Map<string, PendingQuestion>();
export interface AgentQuestionStateChange {
  workspaceDir: string; owner: string; runId: string; conversationId: string; requestId: string;
  pendingQuestionCount: number;
}
const stateListeners = new Set<(change: AgentQuestionStateChange) => void>();

export function subscribeAgentQuestionChanges(listener: (change: AgentQuestionStateChange) => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

export function countAgentQuestions(workspaceDir: string, owner: string, conversationId: string, runId: string): number {
  const workspace = path.resolve(workspaceDir);
  return [...pending.values()].filter((entry) => entry.workspace === workspace && entry.owner === owner
    && entry.question.conversationId === conversationId && entry.question.runId === runId).length;
}

function notifyQuestionState(workspaceDir: string, owner: string, question: AgentQuestion): void {
  const change: AgentQuestionStateChange = {
    workspaceDir, owner, runId: question.runId, conversationId: question.conversationId, requestId: question.requestId,
    pendingQuestionCount: countAgentQuestions(workspaceDir, owner, question.conversationId, question.runId),
  };
  for (const listener of stateListeners) {
    try { listener(change); } catch { /* A disconnected observer must not block an answer. */ }
  }
}
const MAX_PENDING = 200;
const MAX_WAIT_MS = 30 * 60_000;

export function normalizeAgentQuestions(value: unknown): AgentQuestionItem[] {
  if (!Array.isArray(value) || !value.length || value.length > 3) throw new Error("Ask one to three questions");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error("Invalid question");
    const input = item as Record<string, unknown>;
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 2000) throw new Error("A question needs a prompt of at most 2000 characters");
    const options = input.options ?? [];
    if (!Array.isArray(options) || options.length > 6 || options.some((option) => typeof option !== "string" || !option.trim() || option.length > 300)) throw new Error("Invalid question choices");
    if (new Set(options).size !== options.length) throw new Error("Question choices must be unique");
    return { id: `q${index + 1}`, prompt: input.prompt.trim(), options, multiple: input.multiple === true };
  });
}

/** Tool input is already persisted by AgentRunRecorder before this wait begins.
 * A browser reconnect lists the same pending request; a process restart follows
 * the existing interrupted-run recovery, never guesses an unanswered choice. */
export async function requestAgentQuestion(input: {
  workspaceDir: string; owner: string; runId: string; requestId: string;
  toolCallId: string; conversationId: string; questions: unknown; signal?: AbortSignal;
}): Promise<string> {
  const questions = normalizeAgentQuestions(input.questions);
  if (!input.owner || !input.runId || !input.requestId || !input.toolCallId || !input.conversationId) throw new Error("Questions require an active conversation run");
  input.signal?.throwIfAborted();
  if (pending.size >= MAX_PENDING) throw new Error("Too many unanswered questions");
  const workspace = path.resolve(input.workspaceDir);
  const id = crypto.createHash("sha256").update(JSON.stringify([workspace, input.runId, input.requestId, input.toolCallId])).digest("hex").slice(0, 32);
  if (pending.has(id)) throw new Error("Question is already waiting for an answer");
  const createdAt = Date.now();
  const question: AgentQuestion = { id, runId: input.runId, requestId: input.requestId, conversationId: input.conversationId, questions, createdAt, expiresAt: createdAt + MAX_WAIT_MS };
  return new Promise<string>((resolve) => {
    const finish = (result: string) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      notifyQuestionState(workspace, input.owner, question);
      resolve(result);
    };
    const abort = () => finish("Error: Question cancelled because the run stopped. No answer was provided.");
    const timer = setTimeout(() => finish("Error: Question expired without an answer. Do not assume consent or a choice."), MAX_WAIT_MS);
    timer.unref?.();
    pending.set(id, { workspace, owner: input.owner, question, finish });
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    else notifyQuestionState(workspace, input.owner, question);
  });
}

export function listAgentQuestions(workspaceDir: string, owner: string, conversationId?: string): AgentQuestion[] {
  const workspace = path.resolve(workspaceDir);
  return [...pending.values()].filter((entry) => entry.workspace === workspace && entry.owner === owner && (!conversationId || entry.question.conversationId === conversationId)).map((entry) => structuredClone(entry.question));
}

export function answerAgentQuestion(workspaceDir: string, owner: string, id: string, body: unknown): void {
  const entry = pending.get(id);
  if (!entry || entry.workspace !== path.resolve(workspaceDir) || entry.owner !== owner) throw new Error("Question is unavailable or no longer waiting");
  if (!body || typeof body !== "object") throw new Error("Invalid answer");
  const input = body as Record<string, unknown>;
  if (input.requestId !== entry.question.requestId) throw new Error("Question request changed");
  if (input.cancelled === true) {
    entry.finish(JSON.stringify({ status: "cancelled", message: "The user skipped this question. No choice or authorization was given." }));
    return;
  }
  if (!Array.isArray(input.answers) || input.answers.length !== entry.question.questions.length) throw new Error("Answer every question or explicitly skip");
  const answers = entry.question.questions.map((question, index) => {
    const answer = (input.answers as unknown[])[index];
    if (!answer || typeof answer !== "object") throw new Error("Invalid answer");
    const value = answer as Record<string, unknown>;
    if (value.id !== question.id || !Array.isArray(value.selected) || value.selected.some((option) => typeof option !== "string" || !question.options.includes(option))) throw new Error("Answer does not match the question");
    if (new Set(value.selected).size !== value.selected.length || (!question.multiple && value.selected.length > 1)) throw new Error("Invalid number of selected choices");
    const text = typeof value.text === "string" ? value.text.trim() : "";
    if (text.length > 4000 || (!text && !value.selected.length)) throw new Error("Provide a choice or text answer");
    return { id: question.id, question: question.prompt, selected: value.selected, text };
  });
  entry.finish(JSON.stringify({ status: "answered", answers }));
}
