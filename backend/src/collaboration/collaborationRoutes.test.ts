import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { TaskManager } from "../agent/taskManager.js";
import { teamRouter } from "../routes/team.js";
import { setActiveTeamId, setTeamManagerForTests } from "../team/sessionBridge.js";
import { TeamManager } from "../team/teamManager.js";

function git(dir: string, args: string[]) { execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" }); }

test("collaboration REST returns a unified snapshot, enforces CAS, and denies every viewer write", async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-collab-routes-")); const workspace = path.join(outer, "repo"); fs.mkdirSync(workspace); t.after(() => { setTeamManagerForTests(null); fs.rmSync(outer, { recursive: true, force: true }); }); git(workspace, ["init"]); git(workspace, ["config", "user.email", "test@example.com"]); git(workspace, ["config", "user.name", "Test"]); fs.writeFileSync(path.join(workspace, "a.ts"), "line\n"); git(workspace, ["add", "."]); git(workspace, ["commit", "-m", "base"]);
  const manager = new TeamManager(outer); setTeamManagerForTests(manager); const team = manager.createTeam({ username: "owner", teamName: "Team", workspaceDir: workspace }); const invite = manager.createInvite(team.id, "owner", "viewer"); manager.joinTeamByInvite(invite.code, "viewer");
  const teammateManager = { reconcile: () => 0, listDetails: () => [{ id: "agent-one", name: "agent-one", writeScope: ["a.ts"], version: 1 }] }; const owner: any = { username: "owner", token: "owner-token", workspaceDir: workspace, workspaceRoot: workspace, isAdmin: false, isolated: false, teammateManager, taskManager: new TaskManager(workspace) }; const viewer: any = { ...owner, username: "viewer", token: "viewer-token" }; setActiveTeamId(owner, team.id); setActiveTeamId(viewer, team.id);
  const app = express(); app.use(express.json()); app.use((req: any, _res, next) => { req.userSession = req.get("x-user") === "viewer" ? viewer : owner; next(); }); app.use("/api/team", teamRouter); const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve()))); const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}/api/team`;
  const initial = await fetch(`${base}/collaboration`); assert.equal(initial.status, 200); const initialBody = await initial.json() as any; assert.equal(initialBody.collaboration.schemaVersion, 1); assert.equal(initialBody.collaboration.ownership.claims.some((item: any) => item.subject.id === "agent-one"), true);
  const comment = await fetch(`${base}/collaboration/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: initialBody.collaboration.version, body: "Review @agent-one", path: "a.ts", startLine: 1, selectedText: "line", evidenceLinks: ["task:1"] }) }); assert.equal(comment.status, 200);
  const stale = await fetch(`${base}/collaboration/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: initialBody.collaboration.version, body: "stale", path: "a.ts" }) }); assert.equal(stale.status, 409);
  for (const route of ["claims", "comments", "review-requests", "merge-previews", "merge-decisions"]) { const response = await fetch(`${base}/collaboration/${route}`, { method: "POST", headers: { "content-type": "application/json", "x-user": "viewer" }, body: JSON.stringify({}) }); assert.equal(response.status, 403, route); }
  const state = await fetch(`${base}/state`); assert.equal(state.status, 200); const stateBody = await state.json() as any; assert.equal(stateBody.collaboration.comments.length, 1); assert.equal(stateBody.collaboration.activity.some((item: any) => item.type === "mention"), true);
});
