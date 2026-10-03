"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const origin = "http://127.0.0.1:4000";
const masterToken = "a".repeat(64);
const template = fs.readFileSync(path.join(__dirname, "desktop-bridge.js"), "utf8");

function render(bootstrapToken = masterToken) {
  return template
    .replaceAll("__CROWNFORGE_ORIGIN_JSON__", JSON.stringify(origin))
    .replaceAll("__CROWNFORGE_BRIDGE_TOKEN_JSON__", JSON.stringify("window-private-token"))
    .replaceAll("__CROWNFORGE_BOOTSTRAP_TOKEN_JSON__", JSON.stringify(bootstrapToken))
    .replaceAll("__CROWNFORGE_PLATFORM_JSON__", JSON.stringify("darwin"))
    .replaceAll("__CROWNFORGE_VERSION_JSON__", JSON.stringify("1.1.1"));
}

function browser({ href = `${origin}/`, frame = false, bootstrapToken = masterToken } = {}) {
  const calls = [], invocations = [];
  const nativeFetch = function (...args) { calls.push(args); return Promise.resolve({ ok: true }); };
  const window = {
    URL, Headers, Request, location: { href }, fetch: nativeFetch,
    __TAURI_INTERNALS__: { invoke: (...args) => { invocations.push(args); return Promise.resolve({}); } },
  };
  window.top = frame ? {} : window;
  const document = { baseURI: href };
  const context = vm.createContext({ window, document, console });
  vm.runInContext(render(bootstrapToken), context);
  return { window, document, calls, invocations, nativeFetch };
}

test("only the exact bootstrap endpoint receives the private header", async () => {
  const app = browser();
  const signal = new AbortController().signal;
  const init = { method: "GET", headers: { accept: "application/json" }, signal, credentials: "same-origin" };
  await app.window.fetch("/api/auth/me", init);
  const [input, forwarded] = app.calls[0];
  assert.equal(input, `${origin}/api/auth/me`);
  assert.equal(forwarded.headers.get("X-CrownForge-Desktop-Bootstrap"), masterToken);
  assert.equal(forwarded.headers.get("accept"), "application/json");
  assert.equal(forwarded.signal, signal);
  assert.equal(forwarded.credentials, "same-origin");
  assert.deepEqual(init.headers, { accept: "application/json" });
  assert.equal(Object.values(app.window).some((value) => value === masterToken), false);
  assert.deepEqual(Object.keys(app.window.crownforgeDesktop).sort(), ["getPreferences", "onZoomCommand", "openExternal", "platform", "setPreferences", "version", "workspaceChanges"]);
  assert.equal(app.window.crownforgeDesktop.workspaceChanges, "cursor");
  await app.window.crownforgeDesktop.getPreferences();
  assert.equal(app.invocations[0][1].token, "window-private-token");
  assert.equal(Object.values(app.invocations[0][1]).includes(masterToken), false);
});

test("Request identity and existing Request/RequestInit headers survive without mutation", async () => {
  const app = browser({ href: `${origin}/login?next=%2F` });
  const request = new Request(`${origin}/api/auth/me?bootstrap=1`, {
    headers: { authorization: "Bearer fixture", "x-request": "original", "x-input": "one" },
  });
  const headers = new Headers({ "x-request": "override", "x-init": "two", "X-CrownForge-Desktop-Bootstrap": "caller" });
  await app.window.fetch(request, { headers, cache: "no-store" });
  const [forwardedRequest, forwardedInit] = app.calls[0];
  assert.equal(forwardedRequest, request);
  assert.equal(forwardedInit.headers.get("authorization"), "Bearer fixture");
  assert.equal(forwardedInit.headers.get("x-input"), "one");
  assert.equal(forwardedInit.headers.get("x-request"), "override");
  assert.equal(forwardedInit.headers.get("x-init"), "two");
  assert.equal(forwardedInit.headers.get("X-CrownForge-Desktop-Bootstrap"), masterToken);
  assert.equal(forwardedInit.cache, "no-store");
  assert.equal(request.headers.get("x-request"), "original");
  assert.equal(request.headers.has("X-CrownForge-Desktop-Bootstrap"), false);
  assert.equal(headers.get("X-CrownForge-Desktop-Bootstrap"), "caller");
});

test("external origins, preview routes and all other auth paths are forwarded unchanged", async () => {
  const app = browser();
  const targets = [
    "https://example.org/api/auth/me", "http://127.0.0.1:4001/api/auth/me", "http://localhost:4000/api/auth/me",
    "/preview/fixture/", "/api/auth/login", "/api/auth/logout", "/api/auth/me/", "/api/auth/me-other",
    new Request("https://example.org/api/auth/me", { headers: { "x-original": "fixture" } }),
  ];
  for (const target of targets) {
    const init = { headers: new Headers({ "x-existing": "fixture" }) };
    await app.window.fetch(target, init);
    const forwarded = app.calls.at(-1);
    assert.equal(forwarded[0], target);
    assert.equal(forwarded[1], init);
    assert.equal(init.headers.has("X-CrownForge-Desktop-Bootstrap"), false);
  }
  await app.window.fetch("/api/auth/login");
  assert.equal(app.calls.at(-1).length, 1);
});

test("preview, external, credentialed and iframe documents never receive the bridge or wrapper", async () => {
  for (const options of [
    { href: `${origin}/preview/fixture/` }, { href: "https://example.org/" },
    { href: "http://user@127.0.0.1:4000/" }, { frame: true },
  ]) {
    const app = browser(options);
    assert.equal(app.window.fetch, app.nativeFetch);
    assert.equal(app.window.crownforgeDesktop, undefined);
    await app.window.fetch(`${origin}/api/auth/me`);
    assert.equal(app.calls[0].length, 1);
  }
});

test("navigation away from trusted workbench paths stops attaching credentials", async () => {
  const app = browser();
  app.window.location.href = `${origin}/preview/fixture/`;
  const init = { headers: new Headers({ accept: "application/json" }) };
  await app.window.fetch(`${origin}/api/auth/me`, init);
  assert.equal(app.calls[0][1], init);
  assert.equal(init.headers.has("X-CrownForge-Desktop-Bootstrap"), false);
});

test("base URI changes and changing URL conversion cannot leak the credential", async () => {
  const app = browser();
  app.document.baseURI = "https://example.org/";
  await app.window.fetch("/api/auth/me");
  assert.equal(app.calls[0][0], "/api/auth/me");
  assert.equal(app.calls[0].length, 1);
  app.document.baseURI = `${origin}/`;
  let conversions = 0;
  const changing = { toString() { return ++conversions === 1 ? `${origin}/api/auth/me` : "https://example.org/api/auth/me"; } };
  await app.window.fetch(changing);
  assert.equal(app.calls[1][0], `${origin}/api/auth/me`);
  assert.equal(app.calls[1][1].headers.get("X-CrownForge-Desktop-Bootstrap"), masterToken);
  assert.equal(conversions, 1);
});

test("Request subclasses cannot spoof the effective URL to obtain an external credential", async () => {
  const app = browser();
  class SpoofedRequest extends Request { get url() { return `${origin}/api/auth/me`; } }
  const request = new SpoofedRequest("https://example.org/api/auth/me");
  await app.window.fetch(request);
  assert.equal(app.calls[0][0], request);
  assert.equal(app.calls[0].length, 1);
});

test("missing or malformed private credentials fail closed before bridge installation", () => {
  for (const bootstrapToken of ["", "short", null]) {
    assert.throws(() => browser({ bootstrapToken }), /Desktop authentication unavailable/);
  }
});
