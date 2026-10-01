import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Script } from "node:vm";
import test from "node:test";
import express from "express";
import { WebSocket } from "ws";
import { createPreviewContentRouter, handlePreviewUpgrade, previewsRouter } from "../routes/previews.js";
import { discoverPreviewTargets, issuePreviewTicket, listPreviews, previewStatus, resolvePreviewTicket, startPreview, stopPreview, stopPreviewsForToken, validatePreviewPath, verifyPreviewSource } from "./previewService.js";
import { pollProcessSession, type ProcessSessionOwner } from "./processSessions.js";

function fixture(t: test.TestContext): ProcessSessionOwner {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-preview-"));
  fs.writeFileSync(path.join(workspaceDir, "index.html"), '<!doctype html><html><head></head><body><h1>Preview fixture</h1><script type="module" src="/src.tsx"></script></body></html>');
  fs.writeFileSync(path.join(workspaceDir, "src.tsx"), 'export default function App(){return <button>Preview button</button>;}');
  fs.writeFileSync(path.join(workspaceDir, ".env"), "SECRET=private");
  t.after(async () => {
    const owner = { workspaceDir, owner: "alice", sessionToken: "preview-test" };
    for (const preview of listPreviews(owner)) {
      stopPreview(owner, preview.id);
      if (preview.processSessionId) for (let attempt = 0; attempt < 80 && pollProcessSession(owner, preview.processSessionId).session.status === "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  return { workspaceDir, owner: "alice", sessionToken: "preview-test" };
}
async function server(t: test.TestContext, owner: ProcessSessionOwner) {
  const app = express();
  app.use("/preview", createPreviewContentRouter(() => true));
  app.use(express.json());
  app.use("/api/previews", (req, _res, next) => { (req as any).userSession = { username: req.headers["x-test-owner"] || owner.owner, workspaceDir: owner.workspaceDir, token: owner.sessionToken }; next(); }, previewsRouter);
  const listener = http.createServer(app);
  listener.on("upgrade", (request, socket, head) => { if (!handlePreviewUpgrade(request, socket, head, () => true)) socket.destroy(); });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { listener.closeAllConnections(); listener.close(() => resolve()); }));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
function rawGet(url: string, rawPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    http.get({ hostname: target.hostname, port: target.port, path: rawPath, headers }, (response) => {
      let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => body += chunk); response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    }).on("error", reject);
  });
}
test("static previews use ticket authentication, isolate owners, and deny protected paths", async (t) => {
  const owner = fixture(t); const base = await server(t, owner);
  const preview = await startPreview(owner, "static:index.html"); t.after(() => stopPreview(owner, preview.id));
  const ticket = issuePreviewTicket(owner, preview.id);
  const rendered = await rawGet(base, ticket.url, { Authorization: "Bearer ide-auth-token", Cookie: "ide=private", Origin: "null" });
  assert.equal(rendered.status, 200); assert.match(rendered.body, /Preview fixture/); assert.match(rendered.body, /crewforge:preview-event/);
  const injected = rendered.body.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(injected); assert.doesNotThrow(() => new Script(injected));
  assert.match(String(rendered.headers["content-security-policy"]), /sandbox allow-scripts allow-forms/);
  assert.doesNotMatch(String(rendered.headers["content-security-policy"]), /allow-same-origin/);
  assert.doesNotMatch(rendered.body, /ide-auth-token|ide=private|SECRET=private/);
  assert.equal((await rawGet(base, ticket.url, { Origin: "https://attacker.example" })).status, 401);
  for (const suffix of [".env", ".history/private", "%2e%2e/outside", "%252e%252e/outside", "@fs/etc/passwd", "package.json", "private-key.pem", "%00index.html"]) {
    assert.equal((await rawGet(base, ticket.url + suffix)).status, 403, suffix);
  }
  const outside = fixture(t); fs.symlinkSync(path.join(outside.workspaceDir, "index.html"), path.join(owner.workspaceDir, "linked.html"));
  assert.equal((await rawGet(base, ticket.url + "linked.html")).status, 403);
  fs.mkdirSync(path.join(owner.workspaceDir, "public")); fs.symlinkSync(path.join(outside.workspaceDir, "index.html"), path.join(owner.workspaceDir, "public/public-linked.html"));
  assert.equal((await rawGet(base, ticket.url + "public-linked.html")).status, 403);
  assert.throws(() => issuePreviewTicket({ ...owner, owner: "bob" }, preview.id), /not found/);
  assert.throws(() => issuePreviewTicket(outside, preview.id), /not found/);
  const id = ticket.url.split("/")[3]; const item = resolvePreviewTicket(preview.id, id)!;
  item.expiresAt = Date.now() - 1;
  assert.equal((await rawGet(base, ticket.url)).status, 401);
  assert.equal((await fetch(base + "/api/previews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetId: "static:index.html", port: 1234 }) })).status, 400);
  assert.equal((await fetch(base + "/api/previews/" + preview.id, { headers: { "x-test-owner": "bob" } })).status, 404);
});
test("proxy strips IDE credentials and upstream cookies, rejects redirects and unrelated listeners", async (t) => {
  const owner = fixture(t); const base = await server(t, owner);
  const preview = await startPreview(owner, "static:index.html"); t.after(() => stopPreview(owner, preview.id));
  const ticket = issuePreviewTicket(owner, preview.id); const item = resolvePreviewTicket(preview.id, ticket.url.split("/")[3])!;
  const originalPort = item.port;
  let mode = "identity"; let seen: http.IncomingHttpHeaders = {};
  const upstream = http.createServer((req, res) => {
    seen = req.headers;
    if (mode !== "identity") res.setHeader("x-crewforge-preview-proof", item.proof);
    res.setHeader("Set-Cookie", "escape=yes"); res.setHeader("Content-Type", "text/plain");
    if (mode === "redirect") { res.writeHead(302, { Location: "http://127.0.0.1:1/private" }).end(); } else res.end("private listener content");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const address = upstream.address(); assert.ok(address && typeof address !== "string"); item.port = address.port;
  const rejected = await rawGet(base, ticket.url); assert.equal(rejected.status, 502); assert.doesNotMatch(rejected.body, /private listener content/);
  mode = "valid";
  const result = await rawGet(base, ticket.url, { Authorization: "Bearer secret", Cookie: "private-cookie", Origin: "null" });
  assert.equal(result.status, 200); assert.equal(seen.authorization, undefined); assert.equal(seen.cookie, undefined); assert.equal(result.headers["set-cookie"], undefined);
  mode = "redirect"; const redirect = await rawGet(base, ticket.url); assert.equal(redirect.status, 502); assert.equal(redirect.headers.location, undefined);
  item.port = originalPort;
});
test("Vite preview serves transformed React, verifies source candidates and proxies HMR websocket", async (t) => {
  const owner = fixture(t); const base = await server(t, owner);
  const installed = path.resolve("../frontend/node_modules");
  fs.mkdirSync(path.join(owner.workspaceDir, "node_modules"));
  for (const name of ["vite", "react", "react-dom"]) fs.symlinkSync(path.join(installed, name), path.join(owner.workspaceDir, "node_modules", name));
  fs.writeFileSync(path.join(owner.workspaceDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  assert.ok(discoverPreviewTargets(owner.workspaceDir).some((target) => target.id === "vite:npm:dev"));
  const preview = await startPreview(owner, "vite:npm:dev");
  let status = preview;
  for (let attempt = 0; attempt < 160 && status.status === "starting"; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 25)); status = previewStatus(owner, preview.id); }
  const logs = pollProcessSession(owner, preview.processSessionId!).events.map((event) => event.text).join("");
  assert.equal(status.status, "ready", logs);
  const ticket = issuePreviewTicket(owner, preview.id);
  const html = await (await fetch(base + ticket.url)).text(); assert.match(html, /@vite\/client/);
  const transformedResponse = await fetch(base + ticket.url + "src.tsx");
  assert.equal(transformedResponse.status, 200);
  const transformed = await transformedResponse.text();
  assert.match(transformed, /data-crewforge-source/);
  const candidateMatch = transformed.match(/"data-crewforge-source":\s*'([^']+)'/);
  assert.ok(candidateMatch, transformed);
  const candidate = JSON.parse(candidateMatch[1]);
  assert.deepEqual(verifyPreviewSource(owner, preview.id, candidate), { path: "src.tsx", line: 1, column: 38, verified: true });
  assert.throws(() => verifyPreviewSource(owner, preview.id, { ...candidate, path: "../private" }));
  assert.throws(() => verifyPreviewSource(owner, preview.id, { ...candidate, line: 5 }), /Unverified/);
  const clientSource = await (await fetch(base + ticket.url + "@vite/client")).text();
  const wsToken = clientSource.match(/const wsToken = "([^"]+)"/)?.[1];
  const wsUrl = base.replace("http:", "ws:") + ticket.url + (wsToken ? "?token=" + encodeURIComponent(wsToken) : "");
  const ws = new WebSocket(wsUrl, "vite-hmr", { origin: "null" });
  t.after(() => ws.terminate());
  const message = await new Promise<string>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("HMR did not connect")), 7000); ws.once("message", (data) => { clearTimeout(timer); resolve(String(data)); }); ws.once("error", (error) => { clearTimeout(timer); reject(error); }); });
  assert.match(message, /connected/);
  const renewed = issuePreviewTicket(owner, preview.id, ticket.ticket);
  assert.equal(renewed.url, ticket.url); assert.equal(renewed.renewed, true);
  assert.equal(ws.readyState, WebSocket.OPEN);
  const oldClosed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Rotated ticket left the old HMR socket authorized")), 2500);
    ws.once("close", () => { clearTimeout(timer); resolve(); });
  });
  const rotated = issuePreviewTicket(owner, preview.id, "0".repeat(64));
  assert.equal(rotated.renewed, false); assert.notEqual(rotated.url, ticket.url);
  assert.equal((await fetch(base + ticket.url + "src.tsx")).status, 401);
  const rotatedHtml = await (await fetch(base + rotated.url)).text();
  assert.ok(rotatedHtml.includes(rotated.url + "@vite/client")); assert.doesNotMatch(rotatedHtml, /__crewforge_preview__/);
  const rotatedSource = await (await fetch(base + rotated.url + "src.tsx")).text();
  assert.ok(rotatedSource.includes(rotated.url)); assert.equal(rotatedSource.includes(ticket.url), false);
  const rotatedClient = await (await fetch(base + rotated.url + "@vite/client")).text();
  const rotatedWsToken = rotatedClient.match(/const wsToken = "([^"]+)"/)?.[1];
  const nextWs = new WebSocket(base.replace("http:", "ws:") + rotated.url + (rotatedWsToken ? "?token=" + encodeURIComponent(rotatedWsToken) : ""), "vite-hmr", { origin: "null" });
  t.after(() => nextWs.terminate());
  const nextMessage = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HMR did not reconnect after ticket rotation")), 7000);
    nextWs.once("message", (data) => { clearTimeout(timer); resolve(String(data)); }); nextWs.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  assert.match(nextMessage, /connected/);
  await oldClosed;
  fs.writeFileSync(path.join(owner.workspaceDir, "src.tsx"), "changed source");
  assert.throws(() => verifyPreviewSource(owner, preview.id, candidate), /changed/);
  nextWs.close();
});
test("absolute URLs, multiple encodings and path traversal never become proxy targets", (t) => {
  const owner = fixture(t);
  for (const value of ["http://localhost:22/", "//localhost:22/", "/%2e%2e/etc", "/%252e%252e/etc", "/a\\b", "/a/../b"]) assert.throws(() => validatePreviewPath(value, owner.workspaceDir));
});

test("preview metadata from a previous backend is interrupted and cannot issue a ticket", (t) => {
  const owner = fixture(t); const id = crypto.randomUUID();
  const directory = path.join(owner.workspaceDir, ".history/previews"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, id + ".json"), JSON.stringify({ id, targetId: "static:index.html", label: "old preview", kind: "static", status: "ready", createdAt: Date.now(), ownerHash: crypto.createHash("sha256").update(owner.owner).digest("hex"), workspaceDir: owner.workspaceDir }));
  assert.equal(previewStatus(owner, id).status, "interrupted");
  assert.throws(() => issuePreviewTicket(owner, id), /not ready/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, id + ".json"), "utf8")).status, "interrupted");
});

test("authenticated ticket renewal is stable while expiry, wrong tickets and revocation fail safely", async (t) => {
  const owner = fixture(t); const base = await server(t, owner);
  const preview = await startPreview(owner, "static:index.html");
  const post = (id: string, body: unknown = {}, username = owner.owner) => fetch(`${base}/api/previews/${id}/ticket`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-owner": username }, body: JSON.stringify(body) });
  const initialResponse = await post(preview.id); assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json() as ReturnType<typeof issuePreviewTicket>;
  assert.equal(initial.renewed, false); assert.match(initial.ticket, /^[a-f0-9]{64}$/);
  const instance = resolvePreviewTicket(preview.id, initial.ticket)!;
  instance.expiresAt = Date.now() + 1000;
  const renewed = await (await post(preview.id, { ticket: initial.ticket })).json() as ReturnType<typeof issuePreviewTicket>;
  assert.equal(renewed.renewed, true); assert.equal(renewed.ticket, initial.ticket); assert.equal(renewed.url, initial.url);
  assert.ok(renewed.expiresAt > Date.now() + 200_000);
  const [sameOwnerA, sameOwnerB] = await Promise.all([post(preview.id), post(preview.id)]);
  const noBodyA = await sameOwnerA.json() as ReturnType<typeof issuePreviewTicket>;
  const noBodyB = await sameOwnerB.json() as ReturnType<typeof issuePreviewTicket>;
  assert.equal(noBodyA.url, initial.url); assert.equal(noBodyB.url, initial.url); assert.equal(noBodyA.renewed, true);
  assert.equal((await post(preview.id, { ticket: initial.ticket }, "bob")).status, 404);
  assert.equal((await post(crypto.randomUUID(), { ticket: initial.ticket })).status, 404);
  assert.equal((await rawGet(base, initial.url)).status, 200);
  const chosen = "a".repeat(64);
  const rotated = await (await post(preview.id, { ticket: chosen })).json() as ReturnType<typeof issuePreviewTicket>;
  assert.equal(rotated.renewed, false); assert.notEqual(rotated.ticket, chosen); assert.notEqual(rotated.ticket, initial.ticket);
  assert.equal((await rawGet(base, initial.url)).status, 401);
  assert.equal((await rawGet(base, rotated.url)).status, 200);
  resolvePreviewTicket(preview.id, rotated.ticket)!.expiresAt = Date.now() - 1;
  const expired = await (await post(preview.id, { ticket: rotated.ticket })).json() as ReturnType<typeof issuePreviewTicket>;
  assert.equal(expired.renewed, false); assert.notEqual(expired.ticket, rotated.ticket);
  assert.equal((await rawGet(base, rotated.url)).status, 401);
  const other = await startPreview(owner, "static:index.html");
  const otherTicket = await (await post(other.id, { ticket: expired.ticket })).json() as ReturnType<typeof issuePreviewTicket>;
  assert.notEqual(otherTicket.ticket, expired.ticket);
  assert.equal((await rawGet(base, expired.url)).status, 200);
  stopPreviewsForToken(owner.sessionToken!);
  assert.equal((await post(preview.id, { ticket: expired.ticket })).status, 409);
  assert.equal((await rawGet(base, expired.url)).status, 401);
  assert.equal((await post(other.id, { ticket: otherTicket.ticket })).status, 409);
});
