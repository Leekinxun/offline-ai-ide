import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { chatRouter } from "../routes/chat.js";
import { appendConversationMessage } from "./history.js";
import { buildContextManifest, toContextManifestState } from "../agent/contextManifest.js";
import { prepareContextManifest } from "../agent/contextManifestStore.js";

async function serve(workspaceDir: string) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).userSession = { workspaceDir, username: "editor", token: "context-test", isolated: false }; next(); }); app.use(chatRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("context manifest routes paginate summaries, expose safe details, and enforce preference CAS", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-context-routes-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const routePreview = true;\n", "utf8");
  await appendConversationMessage(root, "conversation-1", { role: "user", content: "hello", timestamp: 1 });
  const manifest = buildContextManifest({ providerId: "openai-compatible", modelName: "model", messages: [{ role: "user", content: "hello" }], audit: { storeWorkspaceDir: root, scope: { kind: "workspace", scopeId: "workspace" }, purpose: "agent_turn", agentId: "code", runId: "run-1", conversationId: "conversation-1" } });
  prepareContextManifest(root, manifest);
  const server = await serve(root);
  try {
    const list = await fetch(`${server.base}/context-manifests?runId=run-1&limit=1`); assert.equal(list.status, 200);
    const listBody = await list.json() as { manifests: unknown[]; page: { total: number } };
    assert.deepEqual(listBody.manifests, [toContextManifestState(manifest)]); assert.equal(listBody.page.total, 1);
    const detail = await fetch(`${server.base}/context-manifests/${manifest.manifestId}`); assert.equal(detail.status, 200);
    const detailText = await detail.text(); assert.doesNotMatch(detailText, /hello/); assert.match(detailText, /payloadDigest/);
    const initial = await fetch(`${server.base}/context-preferences/conversation-1`); assert.equal(initial.status, 200);
    const update = await fetch(`${server.base}/context-preferences/conversation-1`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: 0, pins: [{ path: "src/app.ts" }], excludes: ["docs/**"] }) }); assert.equal(update.status, 200);
    const conflict = await fetch(`${server.base}/context-preferences/conversation-1`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: 0, excludes: [] }) }); assert.equal(conflict.status, 409); assert.equal(((await conflict.json()) as { preferences: { version: number } }).preferences.version, 1);
    assert.equal((await fetch(`${server.base}/context-index/status`)).status, 200);
    const canonicalPreview = await fetch(`${server.base}/context/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "conversation-1", query: "routePreview" }) });
    assert.equal(canonicalPreview.status, 200);
    const canonicalText = await canonicalPreview.text();
    assert.match(canonicalText, /src\/app\.ts/);
    assert.doesNotMatch(canonicalText, /export const routePreview/);
    assert.equal((await fetch(`${server.base}/context-preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "conversation-1", query: "app" }) })).status, 200);
    const newConversationPreview = await fetch(`${server.base}/context/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "routePreview" }) });
    assert.equal(newConversationPreview.status, 200);
    assert.equal(((await newConversationPreview.json()) as { preferences: { version: number } }).preferences.version, 0);
    assert.equal((await fetch(`${server.base}/context/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "missing", query: "app" }) })).status, 404);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
