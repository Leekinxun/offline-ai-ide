"use strict";

// The retained Node service uses Electron's process IPC contract. Translate that
// contract onto private host-owned pipes; stdout contains protocol frames only.
const path = require("node:path");
const readline = require("node:readline");
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
process.connected = true;

process.send = (message, sendHandle, options, callback) => {
  const done = [sendHandle, options, callback].find((argument) => typeof argument === "function");
  if (!process.connected) {
    const error = new Error("Desktop host disconnected");
    error.code = "ERR_IPC_CHANNEL_CLOSED";
    if (done) { queueMicrotask(() => done(error)); return false; }
    throw error;
  }
  return protocolWrite(`${JSON.stringify(message)}\n`, done);
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  // No browser or socket can write this stream: only the native parent owns it.
  if (Buffer.byteLength(line) > 65536) return;
  try {
    const message = JSON.parse(line);
    if (message && typeof message === "object" &&
        ["shutdown", "desktop-pick-folder-result"].includes(message.type)) {
      process.emit("message", message);
    }
  } catch { /* Ignore malformed host frames. */ }
});
input.once("close", () => {
  process.connected = false;
  process.emit("disconnect");
  process.emit("message", { type: "shutdown" });
  // A crashed host must not leave the daemon running without its IPC parent.
  setTimeout(() => process.exit(0), 3000).unref();
});

const bootstrap = process.env.CROWNFORGE_BACKEND_BOOTSTRAP;
if (!bootstrap || !path.isAbsolute(bootstrap)) {
  process.send({ type: "error", phase: "bootstrap", code: "INVALID_BACKEND_PATH" }, () => process.exit(1));
} else {
  require(bootstrap);
}
