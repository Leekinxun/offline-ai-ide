import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { TaskManager } from "../agent/taskManager.js";
import { setActiveTeamId, setTeamManagerForTests } from "../team/sessionBridge.js";
import { TeamManager } from "../team/teamManager.js";
import { handleTeamWs } from "../ws/team.js";
import { CollaborationStore, collaborationDigest } from "./collaborationStore.js";

class FakeSocket extends EventEmitter { readyState = WebSocket.OPEN; frames: any[] = []; send(value: string) { this.frames.push(JSON.parse(value)); } }
function git(dir: string, args: string[]) { execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" }); }

test("authorized WS registers exact buffer digests, tracks multiple sockets, denies viewers, and isolates workspaces", (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-collab-ws-")); const workspace = path.join(outer, "one"); const other = path.join(outer, "two"); fs.mkdirSync(workspace); fs.mkdirSync(other); t.after(() => { setTeamManagerForTests(null); fs.rmSync(outer, { recursive: true, force: true }); }); for (const dir of [workspace, other]) { git(dir, ["init"]); git(dir, ["config", "user.email", "test@example.com"]); git(dir, ["config", "user.name", "Test"]); fs.writeFileSync(path.join(dir, "a.ts"), "saved\n"); git(dir, ["add", "."]); git(dir, ["commit", "-m", "base"]); }
  const manager = new TeamManager(outer); setTeamManagerForTests(manager); const team = manager.createTeam({ username: "owner", teamName: "One", workspaceDir: workspace }); const foreign = manager.createTeam({ username: "owner", teamName: "Two", workspaceDir: other }); const invite = manager.createInvite(team.id, "owner", "viewer"); manager.joinTeamByInvite(invite.code, "viewer"); const teammateManager = { reconcile: () => 0, listDetails: () => [] }; const owner: any = { username: "owner", token: "owner", workspaceDir: workspace, workspaceRoot: workspace, isAdmin: false, isolated: false, teammateManager, taskManager: new TaskManager(workspace) }; const viewer: any = { ...owner, username: "viewer", token: "viewer" }; setActiveTeamId(owner, team.id); setActiveTeamId(viewer, team.id);
  const first = new FakeSocket(); const second = new FakeSocket(); handleTeamWs(first as unknown as WebSocket, owner); handleTeamWs(second as unknown as WebSocket, owner); let state = new CollaborationStore(workspace).snapshot(); assert.equal(state.presence.find((item) => item.subject.id === "owner")?.socketCount, 2);
  first.emit("message", Buffer.from(JSON.stringify({ type: "buffer_register", path: "a.ts", version: 1, digest: collaborationDigest("unsaved\n"), savedDigest: collaborationDigest("saved\n"), revision: "editor-1" }))); state = new CollaborationStore(workspace).snapshot(); assert.equal(state.buffers[0]?.dirty, true); assert.equal(state.buffers[0]?.version, 1);
  const viewerSocket = new FakeSocket(); handleTeamWs(viewerSocket as unknown as WebSocket, viewer); viewerSocket.emit("message", Buffer.from(JSON.stringify({ type: "buffer_register", path: "a.ts", version: 1, digest: collaborationDigest("bad\n"), savedDigest: collaborationDigest("saved\n"), revision: "viewer" }))); assert.equal(viewerSocket.frames.some((frame) => frame.type === "team_error" && String(frame.content).startsWith("403")), true); assert.equal(new CollaborationStore(workspace).snapshot().buffers.length, 1);
  first.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", teamId: foreign.id }))); assert.equal(first.frames.some((frame) => frame.type === "team_error" && String(frame.content).includes("403")), true); assert.equal(new CollaborationStore(other).snapshot().buffers.length, 0);
  first.emit("close"); state = new CollaborationStore(workspace).snapshot(); assert.equal(state.presence.find((item) => item.subject.id === "owner")?.online, true); assert.equal(state.presence.find((item) => item.subject.id === "owner")?.socketCount, 1); second.emit("close"); viewerSocket.emit("close"); state = new CollaborationStore(workspace).snapshot(); assert.equal(state.presence.find((item) => item.subject.id === "owner")?.online, false);
});
