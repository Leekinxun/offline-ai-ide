"use strict";

function fail(error) {
  const code = error && ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_INVALID_PACKAGE_CONFIG", "ERR_UNKNOWN_FILE_EXTENSION", "EACCES"].includes(error.code)
    ? error.code
    : "STARTUP_FAILED";
  console.error(`CrewForge backend failed to load (${code})`);
  if (typeof process.send === "function") {
    try {
      process.send({ type: "error", phase: "bootstrap", code }, () => process.exit(1));
      return;
    } catch { /* The host already disconnected. */ }
  }
  process.exit(1);
}

try {
  // Electron 22 embeds Node 16, which lacks the Web APIs used by the backend.
  // Install one matching set before loading any ES modules that might capture them.
  const { serialize, deserialize } = require("node:v8");
  const { pathToFileURL } = require("node:url");
  const path = require("node:path");

  const webApis = ["fetch", "Headers", "Request", "Response", "FormData"];
  if (webApis.some((name) => typeof globalThis[name] !== "function")) {
    const undici = require("undici");
    for (const name of webApis) {
      if (typeof globalThis[name] !== "function") globalThis[name] = undici[name];
    }
  }
  if (typeof globalThis.structuredClone !== "function") {
    globalThis.structuredClone = (value) => deserialize(serialize(value));
  }
  if (typeof globalThis.DOMException !== "function") {
    // Node 16 has a native DOMException for abort reasons but does not expose
    // its constructor globally. Reuse it so AbortError keeps its standard code.
    const probe = new AbortController();
    probe.abort();
    const NativeDOMException = probe.signal.reason?.constructor;
    globalThis.DOMException = typeof NativeDOMException === "function"
      ? NativeDOMException
      : class DOMException extends Error {
          constructor(message = "", name = "Error") {
            super(message);
            this.name = name;
            this.code = name === "AbortError" ? 20 : 0;
          }
        };
  }
  if (typeof AbortSignal.any !== "function") {
    const owners = new WeakMap();
    const finalizer = new FinalizationRegistry((cleanup) => cleanup());
    const makeCleanup = (listeners, token) => () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      listeners.length = 0;
      finalizer.unregister(token);
    };
    const makeListener = (signal, controllerRef, cleanup) => () => {
      controllerRef.deref()?.abort(signal.reason);
      cleanup();
    };
    AbortSignal.any = (signals) => {
      const sources = [...signals];
      if (sources.some((signal) => !(signal instanceof AbortSignal))) {
        throw new TypeError("AbortSignal.any expects AbortSignal values");
      }
      const controller = new AbortController();
      const listeners = [];
      const token = {};
      const cleanup = makeCleanup(listeners, token);
      const controllerRef = new WeakRef(controller);
      // Keep the controller alive while callers hold the returned signal, then
      // release source listeners if that signal is discarded before any abort.
      owners.set(controller.signal, controller);
      finalizer.register(controller.signal, cleanup, token);
      for (const signal of sources) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          cleanup();
          break;
        }
        const listener = makeListener(signal, controllerRef, cleanup);
        signal.addEventListener("abort", listener, { once: true });
        listeners.push([signal, listener]);
      }
      return controller.signal;
    };
  }

  const entryUrl = pathToFileURL(path.join(__dirname, "dist", "index.js")).href;
  import(entryUrl).catch(fail);
} catch (error) {
  fail(error);
}
