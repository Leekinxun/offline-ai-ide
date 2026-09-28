import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import express from "express";
import { processSessionsRouter } from "../routes/processSessions.js";
import { previewsRouter } from "../routes/previews.js";
import { TeamManager } from "../team/teamManager.js";
import { setTeamManagerForTests } from "../team/sessionBridge.js";

test("process and preview control APIs require authentication and reject viewer starts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-session-routes-"));
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ scripts: { check: 'node -e "console.log(1)"' } }));
  fs.writeFileSync(path.join(workspace, "index.html"), "<h1>test</h1>");
  const manager = new TeamManager(root);
  const team = manager.createTeam({ username: "owner", teamName: "test", workspaceDir: workspace });
  const invite = manager.createInvite(team.id, "owner", "viewer");
  manager.joinTeamByInvite(invite.code, "viewer");
  setTeamManagerForTests(manager);
  t.after(() => { setTeamManagerForTests(null); fs.rmSync(root, { recursive: true, force: true }); });
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { if (req.headers["x-user"]) (req as any).userSession = { username: req.headers["x-user"], token: req.headers["x-user"], workspaceDir: workspace }; next(); });
  app.use("/process", processSessionsRouter); app.use("/previews", previewsRouter);
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  for (const [route, body] of [["/process", { taskId: "npm:check" }], ["/previews", { targetId: "static:index.html" }]] as const) {
    assert.equal((await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 401);
    assert.equal((await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "x-user": "viewer" }, body: JSON.stringify(body) })).status, 403);
    assert.equal((await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "x-user": "owner", "X-Workspace-Dir": path.join(root, "another-workspace") }, body: JSON.stringify(body) })).status, 409);
    assert.equal((await fetch(base + route, { headers: { "x-user": "owner", "X-Workspace-Dir": encodeURIComponent(workspace) } })).status, 200);
  }
  assert.equal((await fetch(base + "/process", { method: "POST", headers: { "Content-Type": "application/json", "x-user": "owner" }, body: JSON.stringify({ taskId: "npm:check", command: "arbitrary command" }) })).status, 400);
  assert.equal((await fetch(base + "/previews", { method: "POST", headers: { "Content-Type": "application/json", "x-user": "owner" }, body: JSON.stringify({ targetId: "static:index.html", url: "http://localhost:22" }) })).status, 400);
});
