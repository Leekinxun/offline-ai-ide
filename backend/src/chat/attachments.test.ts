import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import {
  ChatAttachmentError,
  cleanupUnusedChatAttachments,
  readChatAttachment,
  resolveChatAttachments,
  storeChatAttachments,
} from "./attachments.js";
import { appendConversationMessage, deleteConversation, forkConversation, readConversationMessages } from "./history.js";
import { chatRouter } from "../routes/chat.js";

const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 0, 73, 69, 78, 68,
]);
const gifFrame = Buffer.from([
  0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0,
  2, 2, 0x44, 0x01, 0,
]);
const staticGif = Buffer.concat([
  Buffer.from("GIF89a", "ascii"), Buffer.from([1, 0, 1, 0, 0, 0, 0]), gifFrame, Buffer.from([0x3b]),
]);

function workspace(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-attachments-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function upload(name: string, mimetype: string, buffer: Buffer) {
  return { originalname: name, mimetype, buffer };
}

test("stores private attachment bytes and verifies workspace, digest, and file type", (t) => {
  const first = workspace(t);
  const second = workspace(t);
  const [attachment] = storeChatAttachments(first, [upload("diagram.png", "image/png", png)]);
  assert.deepEqual(attachment, {
    id: attachment.id, name: "diagram.png", mimeType: "image/png", size: png.length, kind: "image",
  });
  const directory = path.join(first, ".history", "attachments");
  assert.equal(fs.statSync(directory).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(directory, `${attachment.id}.bin`)).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(directory, `${attachment.id}.json`)).mode & 0o077, 0);
  assert.deepEqual(readChatAttachment(first, attachment.id).bytes, png);
  assert.deepEqual(resolveChatAttachments(first, [attachment.id]), [attachment]);
  assert.throws(() => readChatAttachment(second, attachment.id), (error) => error instanceof ChatAttachmentError && error.status === 404);
  assert.throws(() => readChatAttachment(first, "../diagram.png"), /Invalid attachment id/);

  fs.writeFileSync(path.join(directory, `${attachment.id}.bin`), Buffer.from("not a PNG"), { mode: 0o600 });
  assert.throws(() => readChatAttachment(first, attachment.id), /integrity check failed/);
  fs.rmSync(path.join(directory, `${attachment.id}.bin`));
  const outside = path.join(second, "outside.bin");
  fs.writeFileSync(outside, png);
  fs.symlinkSync(outside, path.join(directory, `${attachment.id}.bin`));
  assert.throws(() => readChatAttachment(first, attachment.id), /storage is invalid/);
});

test("rejects spoofed media, binary text, unsafe names, and oversized batches", (t) => {
  const directory = workspace(t);
  assert.throws(() => storeChatAttachments(directory, [upload("fake.png", "image/png", Buffer.from("hello"))]), /does not match/);
  assert.equal(storeChatAttachments(directory, [upload("still.gif", "image/gif", staticGif)])[0].kind, "image");
  assert.throws(() => storeChatAttachments(directory, [upload("animated.gif", "image/gif", Buffer.concat([
    staticGif.subarray(0, -1), gifFrame, Buffer.from([0x3b]),
  ]))]), /Animated or invalid GIF/);
  assert.throws(() => storeChatAttachments(directory, [upload("script.py", "text/plain", Buffer.from([0xff]))]), /UTF-8/);
  assert.throws(() => storeChatAttachments(directory, [upload("script.py", "text/plain", Buffer.from("hello\0world"))]), /binary data/);
  assert.throws(() => storeChatAttachments(directory, [upload("../script.py", "text/plain", Buffer.from("hello"))]), /Invalid attachment name/);
  assert.throws(() => storeChatAttachments(directory, [upload(".env", "text/plain", Buffer.from("TOKEN=example"))]), /name is not authorized/);
  assert.throws(() => storeChatAttachments(directory, [upload("credentials.json", "application/json", Buffer.from("{}"))]), /name is not authorized/);
  assert.throws(() => storeChatAttachments(directory, [upload("note.txt", "text/plain", Buffer.from("api_key=sk-realvalue123456789"))]), /protected secret/);
  assert.throws(() => storeChatAttachments(directory, [upload("archive.zip", "application/zip", Buffer.from("hello"))]), /Unsupported/);
  assert.throws(() => storeChatAttachments(directory, [upload("large.txt", "text/plain", Buffer.alloc(256 * 1024 + 1, 65))]), /256 KiB/);
  assert.throws(() => storeChatAttachments(directory, Array.from({ length: 5 }, () => upload("a.png", "image/png", png))), /1 to 4/);
  assert.throws(() => storeChatAttachments(directory, Array.from({ length: 3 }, (_, index) => upload(`${index}.png`, "image/png", Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 - png.length)])))), /12 MiB/);
});

test("history stores references without binary data and forks preserve them", async (t) => {
  const directory = workspace(t);
  const [attachment] = storeChatAttachments(directory, [upload("notes.md", "text/markdown", Buffer.from("# Private notes\n"))]);
  await appendConversationMessage(directory, "conversation-one", {
    role: "user", content: "Read this", timestamp: 100, attachments: [attachment],
  });
  const historyPath = path.join(directory, ".history", "conversation-one.jsonl");
  const raw = fs.readFileSync(historyPath, "utf8");
  assert.match(raw, new RegExp(attachment.id));
  assert.doesNotMatch(raw, /Private notes/);
  assert.deepEqual(readConversationMessages(directory, "conversation-one")[0].attachments, [attachment]);
  const fork = forkConversation(directory, "conversation-one");
  assert.deepEqual(readConversationMessages(directory, fork.id)[0].attachments, [attachment]);
  await deleteConversation(directory, "conversation-one");
  assert.equal(cleanupUnusedChatAttachments(directory, Date.now() + 25 * 60 * 60 * 1000), 0);
  assert.deepEqual(readChatAttachment(directory, attachment.id).attachment, attachment);
  await deleteConversation(directory, fork.id);
  assert.throws(() => readChatAttachment(directory, attachment.id), (error) => error instanceof ChatAttachmentError && error.status === 404);
});

test("deleting the sole conversation reference removes its attachment from GET", async (t) => {
  const directory = workspace(t);
  const [attachment] = storeChatAttachments(directory, [upload("only.png", "image/png", png)]);
  await appendConversationMessage(directory, "sole-reference", {
    role: "user", content: "See image", timestamp: Date.now(), attachments: [attachment],
  });
  const [draft] = storeChatAttachments(directory, [upload("draft.txt", "text/plain", Buffer.from("not sent yet"))]);
  await deleteConversation(directory, "sole-reference");
  assert.equal(readChatAttachment(directory, draft.id).attachment.id, draft.id);
  await withChatApi(directory, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat/attachments/${attachment.id}`, {
      headers: { Authorization: "Bearer test-session" },
    });
    assert.equal(response.status, 404);
  });
});

test("pruning old conversations removes attachments absent from retained history", async (t) => {
  const directory = workspace(t);
  const [oldAttachment] = storeChatAttachments(directory, [upload("old.png", "image/png", png)]);
  await appendConversationMessage(directory, "conversation-00", {
    role: "user", content: "old", timestamp: 1, attachments: [oldAttachment],
  });
  const oldConversationPath = path.join(directory, ".history", "conversation-00.jsonl");
  fs.utimesSync(oldConversationPath, new Date(1), new Date(1));
  for (let index = 1; index <= 30; index += 1) {
    await appendConversationMessage(directory, `conversation-${String(index).padStart(2, "0")}`, {
      role: "user", content: `new ${index}`, timestamp: Date.now(),
    });
  }
  assert.equal(fs.existsSync(oldConversationPath), false);
  assert.throws(() => readChatAttachment(directory, oldAttachment.id), (error) => error instanceof ChatAttachmentError && error.status === 404);
});

test("expired uploads without a persisted conversation reference are reclaimed", (t) => {
  const directory = workspace(t);
  const [attachment] = storeChatAttachments(directory, [upload("unused.txt", "text/plain", Buffer.from("unused"))]);
  const orphan = path.join(directory, ".history", "attachments", "att-00000000-0000-0000-0000-000000000001.bin");
  fs.writeFileSync(orphan, "interrupted upload");
  assert.equal(cleanupUnusedChatAttachments(directory, Date.now() + 25 * 60 * 60 * 1000), 2);
  assert.throws(() => readChatAttachment(directory, attachment.id), (error) => error instanceof ChatAttachmentError && error.status === 404);
  assert.equal(fs.existsSync(orphan), false);
});

test("workspace staged byte quota rejects a batch without changing existing files", (t) => {
  const directory = workspace(t);
  const storage = path.join(directory, ".history", "attachments");
  fs.mkdirSync(storage, { recursive: true });
  const existing = path.join(storage, "att-00000000-0000-0000-0000-000000000001.bin");
  fs.writeFileSync(existing, "x");
  fs.truncateSync(existing, 24 * 1024 * 1024);
  const before = fs.readdirSync(storage);
  assert.throws(() => storeChatAttachments(directory, [upload("new.png", "image/png", png)]),
    (error) => error instanceof ChatAttachmentError && error.status === 413 && /24 MiB/.test(error.message));
  assert.deepEqual(fs.readdirSync(storage), before);
  assert.equal(fs.statSync(existing).size, 24 * 1024 * 1024);
});

test("workspace staged count quota rejects a new upload", (t) => {
  const directory = workspace(t);
  const storage = path.join(directory, ".history", "attachments");
  fs.mkdirSync(storage, { recursive: true });
  for (let index = 1; index <= 32; index += 1) {
    fs.writeFileSync(path.join(storage, `att-${index.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000.bin`), "x");
  }
  const before = fs.readdirSync(storage);
  assert.throws(() => storeChatAttachments(directory, [upload("new.png", "image/png", png)]),
    (error) => error instanceof ChatAttachmentError && error.status === 413 && /32 file/.test(error.message));
  assert.deepEqual(fs.readdirSync(storage), before);
});

test("workspace total quota includes historically referenced attachments", (t) => {
  const directory = workspace(t);
  const storage = path.join(directory, ".history", "attachments");
  fs.mkdirSync(storage, { recursive: true });
  const id = "att-00000000-0000-0000-0000-000000000001";
  const existing = path.join(storage, `${id}.bin`);
  fs.writeFileSync(existing, "x");
  fs.truncateSync(existing, 512 * 1024 * 1024);
  fs.writeFileSync(path.join(directory, ".history", "quota.jsonl"), JSON.stringify({
    role: "user", content: "previous upload", timestamp: 1,
    attachments: [{ id, name: "old.png", mimeType: "image/png", size: 1, kind: "image" }],
  }) + "\n");
  const before = fs.readdirSync(storage);
  assert.throws(() => storeChatAttachments(directory, [upload("new.png", "image/png", png)]),
    (error) => error instanceof ChatAttachmentError && error.status === 413 && /512 MiB/.test(error.message));
  assert.deepEqual(fs.readdirSync(storage), before);
  assert.equal(fs.statSync(existing).size, 512 * 1024 * 1024);
});

async function withChatApi(workspaceDir: string, run: (baseUrl: string, setWorkspace: (directory: string) => void) => Promise<void>): Promise<void> {
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

test("authenticated chat upload and download use workspace-scoped opaque IDs", async (t) => {
  const first = workspace(t);
  const second = workspace(t);
  await withChatApi(first, async (baseUrl, setWorkspace) => {
    const form = new FormData();
    form.append("files", new Blob([png], { type: "image/png" }), "diagram.png");
    const unauthenticated = await fetch(`${baseUrl}/api/chat/attachments`, { method: "POST", body: form });
    assert.equal(unauthenticated.status, 401);
    const uploaded = await fetch(`${baseUrl}/api/chat/attachments`, {
      method: "POST", headers: { Authorization: "Bearer test-session" }, body: form,
    });
    assert.equal(uploaded.status, 201);
    const payload = await uploaded.json() as { attachments: Array<{ id: string; kind: string }> };
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].kind, "image");
    const id = payload.attachments[0].id;
    const downloaded = await fetch(`${baseUrl}/api/chat/attachments/${id}`, { headers: { Authorization: "Bearer test-session" } });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "image/png");
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    setWorkspace(second);
    const foreign = await fetch(`${baseUrl}/api/chat/attachments/${id}`, { headers: { Authorization: "Bearer test-session" } });
    assert.equal(foreign.status, 404);
  });
});
