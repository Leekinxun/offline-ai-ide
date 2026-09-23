import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { storeChatAttachments } from "../chat/attachments.js";
import { callChatCompletion } from "./llm.js";
import type { OpenAIMessage } from "./types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n");

test("Chat Completions materializes image, PDF, and bounded text only at request egress", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-llm-parts-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const [image, file, text] = storeChatAttachments(workspace, [
    { originalname: "screenshot.png", mimetype: "image/png", buffer: png },
    { originalname: "design.pdf", mimetype: "application/pdf", buffer: pdf },
    { originalname: "notes.txt", mimetype: "text/plain", buffer: Buffer.from("untrusted example", "utf8") },
  ]);
  const messages: OpenAIMessage[] = [
    { role: "user", content: [
      { type: "text", text: "Explain these" },
      { type: "attachment_ref", attachment: image },
      { type: "attachment_ref", attachment: file },
      { type: "attachment_ref", attachment: text },
    ] },
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", content: "tool answer", tool_call_id: "call-1" },
  ];
  const before = JSON.stringify(messages);
  const originalFetch = globalThis.fetch;
  let body: Record<string, any> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, any>;
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await callChatCompletion({
    apiUrl: "https://provider.invalid/v1", model: "vision-model", messages,
    attachmentWorkspaceDir: workspace, maxTokens: 123, temperature: 0.2, topP: 0.8,
    frequencyPenalty: 0.1, presencePenalty: 0.3,
  });

  assert.equal(JSON.stringify(messages), before);
  assert.equal(body?.messages[0].content[0].text, "Explain these");
  assert.match(body?.messages[0].content[1].text, /Attached image.*untrusted data/);
  assert.deepEqual(body?.messages[0].content[2], { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } });
  assert.match(body?.messages[0].content[3].text, /Attached PDF.*untrusted data/);
  assert.deepEqual(body?.messages[0].content[4], { type: "file", file: { filename: "design.pdf", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` } });
  assert.match(body?.messages[0].content[5].text, /untrusted content.*untrusted example/s);
  assert.equal(body?.messages[1].tool_calls[0].function.name, "read_file");
  assert.equal(body?.messages[2].tool_call_id, "call-1");
  assert.equal(body?.temperature, 0.2);
  assert.equal(body?.top_p, 0.8);
  assert.equal(body?.frequency_penalty, 0.1);
  assert.equal(body?.presence_penalty, 0.3);
  assert.equal(JSON.stringify(body).includes("attachment_ref"), false);
});

test("attachment references require a workspace before any provider request", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return Response.json({}); };
  try {
    await assert.rejects(callChatCompletion({
      apiUrl: "https://provider.invalid/v1", model: "vision-model", maxTokens: 123,
      messages: [{ role: "user", content: [{ type: "attachment_ref", attachment: { id: "att-00000000-0000-0000-0000-000000000000", name: "x.png", mimeType: "image/png", size: 1, kind: "image" } }] }],
    }), /Attachment workspace is unavailable/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("large text attachments carry an explicit truncation notice", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-llm-text-limit-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const [attachment] = storeChatAttachments(workspace, [{
    originalname: "long.txt", mimetype: "text/plain", buffer: Buffer.alloc(150 * 1024, "x"),
  }]);
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    sentText = body.messages[0].content;
    return Response.json({});
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await callChatCompletion({
    apiUrl: "https://provider.invalid/v1", model: "text-model", maxTokens: 100,
    messages: [{ role: "user", content: [{ type: "attachment_ref", attachment }] }],
    attachmentWorkspaceDir: workspace,
  });
  assert.match(sentText, /truncated to 128 KiB/);
  assert.match(sentText, /\[Attachment truncated\]$/);
  assert.ok(sentText.length < 130 * 1024);
});

test("text-only content parts collapse to a string for compatible text models", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-llm-text-only-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const [attachment] = storeChatAttachments(workspace, [{
    originalname: "notes.txt", mimetype: "text/plain", buffer: Buffer.from("reference data", "utf8"),
  }]);
  const originalFetch = globalThis.fetch;
  let content: unknown;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> };
    content = body.messages[0].content;
    return Response.json({});
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await callChatCompletion({
    apiUrl: "https://provider.invalid/v1", model: "text-model", maxTokens: 100,
    messages: [{ role: "user", content: [
      { type: "text", text: "Summarize" },
      { type: "attachment_ref", attachment },
      { type: "text", text: "Focus on facts" },
    ] }],
    attachmentWorkspaceDir: workspace,
  });
  assert.equal(typeof content, "string");
  assert.match(content as string, /^Summarize\n\n\[Attached file .*untrusted content\]\nreference data\n\nFocus on facts$/);
});

test("a request rejects excess attachment references before reading or sending", async () => {
  const ref = (index: number, size: number) => ({
    id: `att-${String(index).padStart(8, "0")}-0000-0000-0000-000000000000`,
    name: `item-${index}.png`, mimeType: "image/png", size, kind: "image" as const,
  });
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return Response.json({}); };
  try {
    await assert.rejects(callChatCompletion({
      apiUrl: "https://provider.invalid/v1", model: "vision-model", maxTokens: 100,
      messages: [
        { role: "user", content: Array.from({ length: 3 }, (_, index) => ({ type: "attachment_ref" as const, attachment: ref(index, 1) })) },
        { role: "user", content: Array.from({ length: 2 }, (_, index) => ({ type: "attachment_ref" as const, attachment: ref(index + 3, 1) })) },
      ],
    }), /at most 4 attachments/);
    await assert.rejects(callChatCompletion({
      apiUrl: "https://provider.invalid/v1", model: "vision-model", maxTokens: 100,
      messages: [
        { role: "user", content: Array.from({ length: 2 }, (_, index) => ({ type: "attachment_ref" as const, attachment: ref(index, 5 * 1024 * 1024) })) },
        { role: "user", content: [{ type: "attachment_ref", attachment: ref(2, 5 * 1024 * 1024) }] },
      ],
    }), /exceed 12 MiB/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});
