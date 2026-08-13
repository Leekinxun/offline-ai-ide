import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateConversationTitle } from "./title.js";
import { listContextManifests } from "../agent/contextManifestStore.js";

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
