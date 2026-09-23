import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateConversationTitle } from "./title.js";
import { listContextManifests } from "../agent/contextManifestStore.js";
import { config } from "../config.js";

test("title generation uses the manifested model processor boundary", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-title-manifest-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { role: "assistant", content: "Fix Context Provenance" }, finish_reason: "stop" }] });
  t.after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
  const title = await generateConversationTitle("Please fix context provenance", { workspaceDir: root, conversationId: "conversation-1", requestId: "request-1" });
  assert.equal(title, "Fix Context Provenance");
  const manifests = listContextManifests(root, { conversationId: "conversation-1" });
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].purpose, "title");
  assert.equal(manifests[0].status, "completed");
});

test("title generation follows the selected model endpoint", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-title-selected-model-"));
  const originalFetch = globalThis.fetch;
  const originalModels = config.models;
  const originalFallbacks = config.modelFallbacks;
  config.models = [{ modelName: "selected-title-model", apiUrl: "https://selected-title.invalid/v1", apiKey: "selected-title-key" }];
  config.modelFallbacks = [];
  const requests: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    return Response.json({ choices: [{ message: { role: "assistant", content: "Selected Model Title" }, finish_reason: "stop" }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    config.models = originalModels;
    config.modelFallbacks = originalFallbacks;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const title = await generateConversationTitle("A private conversation", {
    workspaceDir: root,
    conversationId: "conversation-selected",
    modelName: "selected-title-model",
  });
  assert.equal(title, "Selected Model Title");
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.url.startsWith("https://selected-title.invalid/v1/")));
  assert.ok(requests.every((request) => request.authorization === "Bearer selected-title-key"));
});
