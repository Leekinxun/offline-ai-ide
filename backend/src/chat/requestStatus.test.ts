import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  appendConversationMessage,
  beginChatRequest,
  completeChatRequest,
  deleteConversation,
  failChatRequest,
  forkConversation,
  getChatRequestStatus,
  readConversationMessages,
} from "./history.js";
import { chatRouter } from "../routes/chat.js";

function workspace(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-request-status-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function withApi(workspaceDir: string, run: (baseUrl: string, setWorkspace: (directory: string) => void) => Promise<void>): Promise<void> {
  const app = express();
  let currentWorkspace = workspaceDir;
  app.use("/api/chat", (req, res, next) => {
    if (req.header("authorization") !== "Bearer test-session") return res.status(401).end();
    (req as any).userSession = { workspaceDir: currentWorkspace };
    next();
  }, chatRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`, (directory) => { currentWorkspace = directory; }); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function statusInFreshProcess(directory: string, requestId: string, forbidHistoryRead = false): unknown {
  const backendDir = fileURLToPath(new URL("../..", import.meta.url));
  const child = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import fs from "node:fs"; import { getChatRequestStatus } from "./src/chat/history.ts";
     if (process.env.FORBID_HISTORY_READ === "1") {
       const read = fs.readFileSync;
       fs.readFileSync = function(file, ...args) {
         if (String(file).endsWith(".jsonl")) throw new Error("Unexpected full history scan");
         return read.call(this, file, ...args);
       };
     }
     process.stdout.write(JSON.stringify(getChatRequestStatus(process.env.REQUEST_STATUS_WORKSPACE, process.env.REQUEST_STATUS_ID)));`,
  ], {
    cwd: backendDir,
    env: {
      ...process.env,
      REQUEST_STATUS_WORKSPACE: directory,
      REQUEST_STATUS_ID: requestId,
      FORBID_HISTORY_READ: forbidHistoryRead ? "1" : "0",
    },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("concurrent callers share a processing request and read its accepted conversation", async (t) => {
  const directory = workspace(t);
  assert.deepEqual(beginChatRequest(directory, "request-shared"), { kind: "new" });
  const duplicate = beginChatRequest(directory, "request-shared");
  assert.equal(duplicate.kind, "processing");
  assert.deepEqual(getChatRequestStatus(directory, "request-shared"), { status: "processing" });
  await appendConversationMessage(directory, "conversation-one", {
    role: "user", content: "Do the work", timestamp: Date.now(), requestId: "request-shared",
  });
  completeChatRequest(directory, "request-shared", "conversation-one");
  assert.equal(duplicate.kind === "processing" && await duplicate.completion, "conversation-one");
  assert.deepEqual(beginChatRequest(directory, "request-shared"), { kind: "accepted", conversationId: "conversation-one" });
  assert.equal(readConversationMessages(directory, "conversation-one")[0].requestId, "request-shared");
});

test("accepted request survives a fresh process and a fork does not claim its ID", async (t) => {
  const directory = workspace(t);
  await appendConversationMessage(directory, "source-conversation", {
    role: "user", content: "Original", timestamp: Date.now(), requestId: "request-persisted",
  });
  const fork = forkConversation(directory, "source-conversation");
  assert.equal(readConversationMessages(directory, fork.id)[0].requestId, undefined);
  const indexPath = path.join(directory, ".history", "chat-request-index.json");
  assert.equal(fs.statSync(indexPath).mode & 0o077, 0);
  assert.deepEqual(statusInFreshProcess(directory, "request-persisted", true), { status: "accepted", conversationId: "source-conversation" });
  // Unrelated files under .history change directory mtime without changing any
  // conversation; this must validate signatures without rereading JSONL.
  fs.mkdirSync(path.join(directory, ".history", "unrelated"));
  assert.deepEqual(statusInFreshProcess(directory, "request-persisted", true), { status: "accepted", conversationId: "source-conversation" });
});

test("old history and a corrupt index are rebuilt once for request lookup", (t) => {
  const directory = workspace(t);
  const historyDir = path.join(directory, ".history");
  fs.mkdirSync(historyDir);
  fs.writeFileSync(path.join(historyDir, "legacy-conversation.jsonl"), [
    JSON.stringify({ type: "meta", createdAt: 1, updatedAt: 1 }),
    JSON.stringify({ role: "user", content: "legacy", timestamp: 1, requestId: "request-legacy" }),
  ].join("\n") + "\n");
  assert.deepEqual(getChatRequestStatus(directory, "request-legacy"), { status: "accepted", conversationId: "legacy-conversation" });
  const indexPath = path.join(historyDir, "chat-request-index.json");
  assert.equal(fs.existsSync(indexPath), true);
  fs.writeFileSync(indexPath, "{broken index");
  assert.deepEqual(statusInFreshProcess(directory, "request-legacy"), { status: "accepted", conversationId: "legacy-conversation" });
  assert.deepEqual(statusInFreshProcess(directory, "request-legacy", true), { status: "accepted", conversationId: "legacy-conversation" });
});

test("an index left behind after a conversation write is rebuilt from JSONL", async (t) => {
  const directory = workspace(t);
  await appendConversationMessage(directory, "conversation-crash", {
    role: "user", content: "first", timestamp: 1, requestId: "request-before-crash",
  });
  // Simulate a process stopping after the conversation write but before its
  // request index could be updated.
  fs.appendFileSync(path.join(directory, ".history", "conversation-crash.jsonl"),
    JSON.stringify({ role: "user", content: "second", timestamp: 2, requestId: "request-after-crash" }) + "\n");
  assert.deepEqual(statusInFreshProcess(directory, "request-after-crash"),
    { status: "accepted", conversationId: "conversation-crash" });
  assert.deepEqual(statusInFreshProcess(directory, "request-after-crash", true),
    { status: "accepted", conversationId: "conversation-crash" });
});

test("deleted and pruned conversations disappear from the persisted request index", async (t) => {
  const directory = workspace(t);
  await appendConversationMessage(directory, "deleted-conversation", {
    role: "user", content: "delete", timestamp: 1, requestId: "request-deleted",
  });
  await deleteConversation(directory, "deleted-conversation");
  assert.deepEqual(statusInFreshProcess(directory, "request-deleted", true), { status: "unknown" });

  await appendConversationMessage(directory, "conversation-00", {
    role: "user", content: "old", timestamp: 1, requestId: "request-pruned",
  });
  fs.utimesSync(path.join(directory, ".history", "conversation-00.jsonl"), new Date(1), new Date(1));
  for (let index = 1; index <= 30; index += 1) {
    await appendConversationMessage(directory, `conversation-${String(index).padStart(2, "0")}`, {
      role: "user", content: `new ${index}`, timestamp: Date.now(), requestId: `request-${index}`,
    });
  }
  assert.deepEqual(statusInFreshProcess(directory, "request-pruned", true), { status: "unknown" });
  assert.deepEqual(statusInFreshProcess(directory, "request-30", true), { status: "accepted", conversationId: "conversation-30" });
});

test("failed reservations settle waiters and can be retried", async (t) => {
  const directory = workspace(t);
  assert.equal(beginChatRequest(directory, "request-retry").kind, "new");
  const duplicate = beginChatRequest(directory, "request-retry");
  assert.equal(duplicate.kind, "processing");
  failChatRequest(directory, "request-retry");
  assert.equal(duplicate.kind === "processing" && await duplicate.completion, null);
  assert.deepEqual(getChatRequestStatus(directory, "request-retry"), { status: "unknown" });
  assert.equal(beginChatRequest(directory, "request-retry").kind, "new");
  failChatRequest(directory, "request-retry");
  assert.throws(() => beginChatRequest(directory, "bad id"), /Invalid chat request id/);
  assert.throws(() => getChatRequestStatus(directory, "../bad"), /Invalid chat request id/);
});

test("request status HTTP route isolates workspaces and reports invalid IDs", async (t) => {
  const first = workspace(t);
  const second = workspace(t);
  await appendConversationMessage(first, "conversation-one", {
    role: "user", content: "Hello", timestamp: Date.now(), requestId: "request-http",
  });
  await withApi(first, async (baseUrl, setWorkspace) => {
    const headers = { Authorization: "Bearer test-session" };
    const unauthenticated = await fetch(`${baseUrl}/api/chat/request-status/request-http`);
    assert.equal(unauthenticated.status, 401);
    const accepted = await fetch(`${baseUrl}/api/chat/request-status/request-http`, { headers });
    assert.deepEqual(await accepted.json(), { status: "accepted", conversationId: "conversation-one" });
    const history = await fetch(`${baseUrl}/api/chat/conversations/conversation-one`, { headers });
    const payload = await history.json() as { messages: Array<{ requestId?: string }> };
    assert.equal(payload.messages[0].requestId, "request-http");
    const invalid = await fetch(`${baseUrl}/api/chat/request-status/bad%20id`, { headers });
    assert.equal(invalid.status, 400);
    setWorkspace(second);
    const foreign = await fetch(`${baseUrl}/api/chat/request-status/request-http`, { headers });
    assert.deepEqual(await foreign.json(), { status: "unknown" });
    assert.equal(beginChatRequest(second, "request-http").kind, "new");
    const processing = await fetch(`${baseUrl}/api/chat/request-status/request-http`, { headers });
    assert.deepEqual(await processing.json(), { status: "processing" });
    failChatRequest(second, "request-http");
  });
});
