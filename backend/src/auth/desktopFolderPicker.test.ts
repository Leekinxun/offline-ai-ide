import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DesktopFolderPickerTimeoutError,
  pickDesktopFolder,
} from "./desktopFolderPicker.js";

class FakeIpc extends EventEmitter {
  sent: unknown[] = [];

  send(message: unknown): void {
    this.sent.push(message);
  }
}

test("desktop folder picker resolves only the matching request id", async () => {
  const ipc = new FakeIpc();
  const promise = pickDesktopFolder("/workspace", { ipc: ipc as any, timeoutMs: 1_000 });
  const request = ipc.sent[0] as { type: string; requestId: string; defaultPath: string };
  assert.equal(request.type, "desktop-pick-folder");
  assert.equal(request.defaultPath, "/workspace");

  ipc.emit("message", {
    type: "desktop-pick-folder-result",
    requestId: "other-request",
    path: "/wrong",
  });
  ipc.emit("message", {
    type: "desktop-pick-folder-result",
    requestId: request.requestId,
    path: "/selected",
  });

  assert.deepEqual(await promise, { path: "/selected" });
  assert.equal(ipc.listenerCount("message"), 0);
  assert.equal(ipc.listenerCount("disconnect"), 0);
});

test("desktop folder picker cleans up after timeout", async () => {
  const ipc = new FakeIpc();
  await assert.rejects(
    () => pickDesktopFolder("/workspace", { ipc: ipc as any, timeoutMs: 1 }),
    DesktopFolderPickerTimeoutError
  );
  assert.equal(ipc.listenerCount("message"), 0);
  assert.equal(ipc.listenerCount("disconnect"), 0);
});
