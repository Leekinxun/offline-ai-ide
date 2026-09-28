import assert from "node:assert/strict";
import test from "node:test";
import { answerAgentQuestion, listAgentQuestions, normalizeAgentQuestions, requestAgentQuestion, subscribeAgentQuestionChanges } from "./agentQuestions.js";

test("structured questions survive client refresh and enforce workspace, owner, request and choices", async () => {
  const controller = new AbortController();
  const response = requestAgentQuestion({ workspaceDir: "/tmp/question-fixture", owner: "alice", runId: "run", requestId: "req", toolCallId: "tool", conversationId: "chat", questions: [{ prompt: "Choose scope", options: ["One file", "Whole module"] }], signal: controller.signal });
  try {
    const [question] = listAgentQuestions("/tmp/question-fixture", "alice", "chat");
    assert.equal(listAgentQuestions("/tmp/question-fixture", "bob").length, 0);
    assert.equal(listAgentQuestions("/tmp/another-fixture", "alice").length, 0);
    assert.deepEqual(listAgentQuestions("/tmp/question-fixture", "alice", "chat"), [question]);
    const answer = { requestId: "req", answers: [{ id: "q1", selected: ["One file"], text: "" }] };
    assert.throws(() => answerAgentQuestion("/tmp/question-fixture", "bob", question.id, answer));
    assert.throws(() => answerAgentQuestion("/tmp/question-fixture", "alice", question.id, { ...answer, requestId: "stale" }));
    assert.throws(() => answerAgentQuestion("/tmp/question-fixture", "alice", question.id, { ...answer, answers: [{ id: "q1", selected: ["invented"] }] }));
    answerAgentQuestion("/tmp/question-fixture", "alice", question.id, answer);
    assert.equal(JSON.parse(await response).answers[0].selected[0], "One file");
    assert.equal(listAgentQuestions("/tmp/question-fixture", "alice").length, 0);
    assert.throws(() => answerAgentQuestion("/tmp/question-fixture", "alice", question.id, answer));
  } finally { controller.abort(); }
});

test("cancellation and skipping never synthesize a user choice", async () => {
  const controller = new AbortController();
  const input = { workspaceDir: "/tmp/question-cancel-fixture", owner: "alice", runId: "run", requestId: "req", toolCallId: "tool", conversationId: "chat", questions: [{ prompt: "Details?" }], signal: controller.signal };
  const response = requestAgentQuestion(input);
  controller.abort();
  assert.match(await response, /No answer was provided/);
  const skipped = requestAgentQuestion({ ...input, signal: undefined });
  const [question] = listAgentQuestions(input.workspaceDir, "alice");
  answerAgentQuestion(input.workspaceDir, "alice", question.id, { requestId: "req", cancelled: true });
  assert.equal(JSON.parse(await skipped).status, "cancelled");
});

test("questions reject empty, duplicate and excessive input", () => {
  assert.throws(() => normalizeAgentQuestions([]));
  assert.throws(() => normalizeAgentQuestions([{ prompt: "x", options: ["a", "a"] }]));
  assert.throws(() => normalizeAgentQuestions(Array.from({ length: 4 }, () => ({ prompt: "x" }))));
});

test("question lifecycle publishes scoped counts after create, skip and abort without duplicate completion", async () => {
  const controller = new AbortController();
  const changes: Array<{ owner: string; runId: string; conversationId: string; pendingQuestionCount: number }> = [];
  const unsubscribe = subscribeAgentQuestionChanges((change) => { if (change.runId === "notification-run") changes.push(change); });
  const input = { workspaceDir: "/tmp/question-state-fixture", owner: "alice", runId: "notification-run", requestId: "req", conversationId: "chat", questions: [{ prompt: "Scope?" }], signal: controller.signal };
  try {
    const first = requestAgentQuestion({ ...input, toolCallId: "one" });
    const [question] = listAgentQuestions(input.workspaceDir, "alice");
    answerAgentQuestion(input.workspaceDir, "alice", question.id, { requestId: "req", cancelled: true });
    await first;
    const second = requestAgentQuestion({ ...input, toolCallId: "two" });
    controller.abort(); await second;
    controller.abort();
    assert.deepEqual(changes.map((change) => change.pendingQuestionCount), [1, 0, 1, 0]);
    assert.ok(changes.every((change) => change.owner === "alice" && change.conversationId === "chat"));
  } finally { controller.abort(); unsubscribe(); }
});
