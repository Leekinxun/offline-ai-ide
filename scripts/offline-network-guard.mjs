import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const enabled = process.env.WS15_OFFLINE_GUARD === "1";
const auditFile = process.env.WS15_NETWORK_AUDIT_FILE;

function audit(event) {
  if (!auditFile) return;
  try { fs.appendFileSync(auditFile, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`, { mode: 0o600 }); }
  catch { /* Verification still fails on attempted egress even if audit persistence is unavailable. */ }
}

function normalizedHost(value) {
  return String(value || "localhost").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHost(value) {
  const host = normalizedHost(value);
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function deny(kind, host) {
  const error = new Error(`WS15 external network denied: ${kind} ${normalizedHost(host)}`);
  error.code = "WS15_EXTERNAL_NETWORK_DENIED";
  audit({ type: "external_egress_blocked", kind, host: normalizedHost(host) });
  throw error;
}

function hostFromSocketArgs(args) {
  const first = args[0];
  if (Array.isArray(first)) return hostFromSocketArgs(first);
  if (first && typeof first === "object") {
    if (typeof first.path === "string") return null;
    return first.host || first.hostname || "localhost";
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null;
  return typeof args[1] === "string" ? args[1] : "localhost";
}

function hostFromRequestArgs(args) {
  const first = args[0];
  if (first instanceof URL) return first.hostname;
  if (typeof first === "string") {
    try { return new URL(first).hostname; }
    catch { return "localhost"; }
  }
  return first?.hostname || first?.host || "localhost";
}

if (enabled) {
  audit({ type: "guard_loaded" });

  const socketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    const host = hostFromSocketArgs(args);
    if (host !== null && !isLoopbackHost(host)) deny("tcp", host);
    return socketConnect.apply(this, args);
  };

  const patchRequestModule = (module, protocol) => {
    const request = module.request;
    const get = module.get;
    module.request = function guardedRequest(...args) {
      const host = hostFromRequestArgs(args);
      if (!isLoopbackHost(host)) deny(protocol, host);
      return request.apply(this, args);
    };
    module.get = function guardedGet(...args) {
      const host = hostFromRequestArgs(args);
      if (!isLoopbackHost(host)) deny(protocol, host);
      return get.apply(this, args);
    };
  };
  patchRequestModule(http, "http");
  patchRequestModule(https, "https");

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function guardedFetch(input, init) {
      const raw = typeof input === "string" || input instanceof URL ? input : input?.url;
      let host = "localhost";
      try { host = new URL(raw).hostname; }
      catch { /* Relative fetch targets are treated as local and left to the caller. */ }
      if (!isLoopbackHost(host)) deny("fetch", host);
      return originalFetch.call(this, input, init);
    };
  }
}

export { isLoopbackHost };
