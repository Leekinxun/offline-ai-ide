import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { WebSocket } from "ws";
import { clearAgentHooksForTests, registerAgentHooks } from "../agent/agentHooks.js";
import { agentProfileAllowsTool, resolveAgentProfile } from "../agent/agentProfiles.js";
import { runAgentLoop } from "../agent/loop.js";
import { getMcpClient } from "../agent/mcp.js";
import { MessageBus } from "../agent/messageBus.js";
import { TaskManager } from "../agent/taskManager.js";
import { TeammateManager } from "../agent/teammateManager.js";
import type { UserSession } from "../auth/sessionManager.js";
import { TraceStore } from "../chat/traceStore.js";
import { config } from "../config.js";
import { assertCompletionGateToken, beginCompletionAttempt, clearCompletionGateCacheForTests, runRepositoryCompletionGate } from "../extensions/policy/completionGate.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { ExtensionPolicyStore } from "../extensions/policy/store.js";
import { reloadExternalPlugins } from "../plugins/registry.js";
import { extensionsPolicyRouter } from "../routes/extensionsPolicy.js";
import { setActiveTeamId, setTeamManagerForTests } from "../team/sessionBridge.js";
import { TeamManager } from "../team/teamManager.js";
import { handleChatWs } from "../ws/chat.js";

function sessionFor(workspaceDir: string, username = "owner", isAdmin = false): UserSession {
  const taskManager = new TaskManager(workspaceDir); const messageBus = new MessageBus(workspaceDir);
  return { token: `${username}-${crypto.randomUUID()}`, username, workspaceDir, workspaceRoot: workspaceDir, isAdmin, isolated: false, taskManager, messageBus, teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager) };
}

async function withModelFetch<T>(operation: () => Promise<T>, hookOrigin?: string, observedBodies?: string[]): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (hookOrigin && url.startsWith(hookOrigin)) return original(input, init);
    observedBodies?.push(String(init?.body || ""));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  try { return await operation(); } finally { globalThis.fetch = original; }
}

function canonicalManifest(value: Record<string, unknown>): Buffer {
  const normalize = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(normalize) : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).filter(([key]) => key !== "signature").sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)])) : entry;
  return Buffer.from(JSON.stringify(normalize(value)));
}

function writeSignedPlugin(input: { pluginsDir: string; origin: string; privateKey: crypto.KeyObject; failureMode: "open" | "closed"; blocksCompletion: boolean }): void {
  const directory = path.join(input.pluginsDir, "signed-runtime"); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "index.js"), "export default {};\n");
  const sandbox = { readPaths: ["."], writePaths: [], networkOrigins: [input.origin], secretEnv: [] };
  const manifest: Record<string, unknown> = {
    id: "signed-runtime", name: "Signed runtime", version: input.failureMode === "closed" ? "1" : "2", entry: "index.js", permissions: ["hook.http.request"], sandbox,
    hooks: [{ id: "quality", event: "completion.quality", permissions: ["hook.http.request"], transport: { kind: "http", url: `${input.origin}/quality`, method: "POST" }, sandbox, failureMode: input.failureMode, timeoutMs: 2_000, maxRetries: 0, maxOutputBytes: 4_096, blocksCompletion: input.blocksCompletion }],
  };
  manifest.signature = { algorithm: "ed25519", keyId: "runtime-key", value: crypto.sign(null, canonicalManifest(manifest), input.privateKey).toString("base64") };
  fs.writeFileSync(path.join(directory, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeSignedMcpPlugin(input: { pluginsDir: string; privateKey: crypto.KeyObject; origin: string; serverId: string; failureMode: "open" | "closed"; version: string }): void {
  const directory = path.join(input.pluginsDir, "signed-mcp"); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "index.js"), "export default {};\n");
  const sandbox = { readPaths: ["."], writePaths: [], networkOrigins: [input.origin], secretEnv: [] };
  const manifest: Record<string, unknown> = {
    id: "signed-mcp", name: "Signed MCP", version: input.version, entry: "index.js", permissions: ["hook.mcp.call"], sandbox,
    hooks: [{ id: "quality", event: "completion.quality", permissions: ["hook.mcp.call"], transport: { kind: "mcp", serverId: input.serverId, toolName: "validate", arguments: { strict: true } }, sandbox, failureMode: input.failureMode, timeoutMs: 2_000, maxRetries: 0, maxOutputBytes: 4_096, blocksCompletion: false }],
  };
  manifest.signature = { algorithm: "ed25519", keyId: "runtime-key", value: crypto.sign(null, canonicalManifest(manifest), input.privateKey).toString("base64") };
  fs.writeFileSync(path.join(directory, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  frames: any[] = [];
  send(value: string): void { this.frames.push(JSON.parse(value)); }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, debug?: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(`Timed out waiting for websocket completion state: ${JSON.stringify(debug?.())}`); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test("real agent loop loads nested AGENTS for the active scope and admin deny removes raw-profile write_file exposure", async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "g006-runtime-loop-")); const workspace = path.join(outer, "workspace"); const adminPath = path.join(outer, "admin.json"); fs.mkdirSync(path.join(workspace, "packages", "app", "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RUNTIME_ROOT_RULE"); fs.writeFileSync(path.join(workspace, "packages", "AGENTS.md"), "RUNTIME_PACKAGE_RULE"); fs.writeFileSync(path.join(workspace, "packages", "app", "AGENTS.md"), "RUNTIME_DEEPEST_RULE");
  const oldAdmin = process.env.CREWFORGE_ADMIN_POLICY; process.env.CREWFORGE_ADMIN_POLICY = adminPath; t.after(() => { oldAdmin === undefined ? delete process.env.CREWFORGE_ADMIN_POLICY : process.env.CREWFORGE_ADMIN_POLICY = oldAdmin; fs.rmSync(outer, { recursive: true, force: true }); });
  new ExtensionPolicyStore(workspace, adminPath).putAdminPolicy({ permissions: { allow: ["*"], deny: ["write_file"] }, sandbox: { readPaths: ["."], writePaths: ["."], networkOrigins: [], secretEnv: [] } }, 1);
  assert.equal(agentProfileAllowsTool(resolveAgentProfile("code"), "write_file"), true, "the raw profile intentionally remains broad");
  const bodies: string[] = [];
  await withModelFetch(() => runAgentLoop(new FakeSocket() as unknown as WebSocket, "edit active file", "scope-request", sessionFor(workspace), { path: "packages/app/src/index.ts", content: "export {};", language: "typescript" }, undefined, undefined, undefined, undefined, undefined, { isStopped: () => false, createAbortSignal: () => undefined, mode: "code", modelName: "test-model", conversationId: "scope-conversation" }), undefined, bodies);
  const payload = JSON.parse(bodies.find((body) => body.includes("scope-request") || body.includes("RUNTIME_ROOT_RULE")) || bodies[0]) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> };
  const system = payload.messages.find((message) => message.role === "system")?.content || "";
  assert.ok(system.indexOf("RUNTIME_ROOT_RULE") < system.indexOf("RUNTIME_PACKAGE_RULE")); assert.ok(system.indexOf("RUNTIME_PACKAGE_RULE") < system.indexOf("RUNTIME_DEEPEST_RULE"));
  assert.equal(payload.tools?.some((tool) => tool.function.name === "write_file"), false);
});

test("signed registry hooks gate loop, websocket, and task completion, fail open with trace evidence, and reload without duplication", async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "g006-runtime-hook-")); const workspace = path.join(outer, "workspace"); const pluginsDir = path.join(outer, "plugins"); const adminPath = path.join(outer, "admin.json"); fs.mkdirSync(workspace); fs.mkdirSync(pluginsDir);
  let hookCalls = 0; const server = http.createServer((_req, res) => { hookCalls += 1; res.statusCode = 500; res.end("quality failed"); }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); const oldPluginsDir = config.pluginsDir; const oldAdmin = process.env.CREWFORGE_ADMIN_POLICY; const oldKeys = process.env.CREWFORGE_PLUGIN_TRUST_KEYS; config.pluginsDir = pluginsDir; process.env.CREWFORGE_ADMIN_POLICY = adminPath; process.env.CREWFORGE_PLUGIN_TRUST_KEYS = JSON.stringify({ "runtime-key": publicKey.export({ type: "spki", format: "pem" }).toString() });
  t.after(async () => { clearCompletionGateCacheForTests(); clearAgentHooksForTests(); config.pluginsDir = oldPluginsDir; oldAdmin === undefined ? delete process.env.CREWFORGE_ADMIN_POLICY : process.env.CREWFORGE_ADMIN_POLICY = oldAdmin; oldKeys === undefined ? delete process.env.CREWFORGE_PLUGIN_TRUST_KEYS : process.env.CREWFORGE_PLUGIN_TRUST_KEYS = oldKeys; await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(outer, { recursive: true, force: true }); });
  const sandbox = { readPaths: ["."], writePaths: [], networkOrigins: [origin], secretEnv: [] }; new ExtensionPolicyStore(workspace, adminPath).putAdminPolicy({ permissions: { allow: ["*"], deny: [] }, sandbox }, 1);
  writeSignedPlugin({ pluginsDir, origin, privateKey, failureMode: "closed", blocksCompletion: true }); const loaded = reloadExternalPlugins(); assert.equal(loaded[0]?.signatureStatus, "verified"); assert.equal(loaded[0]?.validationError, undefined); assert.equal(loaded[0]?.hooks[0]?.event, "completion.quality");
  await assert.rejects(withModelFetch(() => runAgentLoop(new FakeSocket() as unknown as WebSocket, "finish", "closed-loop", sessionFor(workspace), undefined, undefined, undefined, undefined, undefined, undefined, { isStopped: () => false, createAbortSignal: () => undefined, mode: "ask", modelName: "test-model", conversationId: "closed-loop-conversation" }), origin), /blocked|quality|hook/i);
  assert.ok(new TraceStore(workspace).list().some((entry) => entry.action === "extension_hook:completion.quality" && entry.metadata?.blocked === true));
  const ws = new FakeSocket(); handleChatWs(ws as unknown as WebSocket, sessionFor(workspace)); await withModelFetch(async () => { ws.emit("message", Buffer.from(JSON.stringify({ type: "message", requestId: "closed-ws", message: "finish", mode: "ask", modelName: config.modelName }))); await waitFor(() => ws.frames.some((frame) => frame.type === "run_state" && frame.status === "failed"), 5_000, () => ws.frames); }, origin);
  assert.equal(ws.frames.some((frame) => frame.type === "summary" && frame.completionEvidence?.outcome === "completed"), false);
  const manager = new TaskManager(workspace); const taskId = JSON.parse(manager.create("quality gated task")).id as number; const lease = manager.claimLease(taskId, "agent-one")!; await assert.rejects(manager.completeAfterQualityGate(taskId, "agent-one", lease.token, ["done"], "closed-task"), /blocked|quality|hook/i); assert.notEqual(manager.getTask(taskId).status, "completed");
  writeSignedPlugin({ pluginsDir, origin, privateKey, failureMode: "open", blocksCompletion: false }); reloadExternalPlugins(); reloadExternalPlugins(); clearCompletionGateCacheForTests(); const beforeOpen = hookCalls;
  const completed = await withModelFetch(() => runAgentLoop(new FakeSocket() as unknown as WebSocket, "finish safely", "open-loop", sessionFor(workspace), undefined, undefined, undefined, undefined, undefined, undefined, { isStopped: () => false, createAbortSignal: () => undefined, mode: "ask", modelName: "test-model", conversationId: "open-loop-conversation" }), origin);
  assert.equal(completed.at(-1)?.content, "done"); assert.equal(hookCalls - beforeOpen, 1, "registry reload must replace rather than duplicate hook registrations");
  assert.ok(new TraceStore(workspace).list().some((entry) => entry.action === "Repository completion quality gate" && entry.decision === "passed_with_warnings"));
});

test("signed registry MCP hook calls the configured server tool once and honors permission plus fail policy", async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "g006-runtime-mcp-")); const workspace = path.join(outer, "workspace"); const pluginsDir = path.join(outer, "plugins"); const adminPath = path.join(outer, "admin.json"); fs.mkdirSync(workspace); fs.mkdirSync(pluginsDir);
  let toolCalls = 0; let observedCall: any;
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
    response.setHeader("content-type", "application/json"); response.setHeader("mcp-session-id", "g006-session");
    if (payload.method === "initialize") response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { capabilities: {} } }));
    else if (payload.method === "tools/list") response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "validate", inputSchema: { type: "object" } }] } }));
    else if (payload.method === "tools/call") { toolCalls += 1; observedCall = payload.params; response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: "valid" }] } })); }
    else { response.statusCode = 400; response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { message: "unknown method" } })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const oldPluginsDir = config.pluginsDir; const oldServers = config.mcpServers; const oldBaseUrls = config.mcpBaseUrls; const oldLazyUrls = config.mcpLazyUrls; const oldDisabledUrls = config.mcpDisabledUrls; const oldAdmin = process.env.CREWFORGE_ADMIN_POLICY; const oldKeys = process.env.CREWFORGE_PLUGIN_TRUST_KEYS;
  config.pluginsDir = pluginsDir; config.mcpServers = [{ id: "quality-server", transport: "remote", url: `${origin}/mcp` }]; config.mcpBaseUrls = []; config.mcpLazyUrls = []; config.mcpDisabledUrls = []; process.env.CREWFORGE_ADMIN_POLICY = adminPath; process.env.CREWFORGE_PLUGIN_TRUST_KEYS = JSON.stringify({ "runtime-key": publicKey.export({ type: "spki", format: "pem" }).toString() }); clearAgentHooksForTests(); clearCompletionGateCacheForTests(); getMcpClient().dispose();
  t.after(async () => { getMcpClient().dispose(); clearCompletionGateCacheForTests(); clearAgentHooksForTests(); config.pluginsDir = oldPluginsDir; config.mcpServers = oldServers; config.mcpBaseUrls = oldBaseUrls; config.mcpLazyUrls = oldLazyUrls; config.mcpDisabledUrls = oldDisabledUrls; oldAdmin === undefined ? delete process.env.CREWFORGE_ADMIN_POLICY : process.env.CREWFORGE_ADMIN_POLICY = oldAdmin; oldKeys === undefined ? delete process.env.CREWFORGE_PLUGIN_TRUST_KEYS : process.env.CREWFORGE_PLUGIN_TRUST_KEYS = oldKeys; await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(outer, { recursive: true, force: true }); });

  const sandbox = { readPaths: ["."], writePaths: [], networkOrigins: [origin], secretEnv: [] }; const policy = new ExtensionPolicyStore(workspace, adminPath); policy.putAdminPolicy({ permissions: { allow: ["hook.mcp.call"], deny: [] }, sandbox }, 1);
  const runGate = (runId: string) => runRepositoryCompletionGate({ workspaceDir: workspace, runId, attemptToken: beginCompletionAttempt({ workspaceDir: workspace, runId }), agentId: "code" });
  writeSignedMcpPlugin({ pluginsDir, privateKey, origin, serverId: "quality-server", failureMode: "closed", version: "1" }); const loaded = reloadExternalPlugins(); assert.equal(loaded[0]?.signatureStatus, "verified"); assert.equal(loaded[0]?.validationError, undefined);
  const passed = await runGate("mcp-success"); assert.equal(passed.status, "passed"); assert.equal(toolCalls, 1); assert.equal(observedCall?.name, "validate"); assert.equal(observedCall?.arguments?.strict, true); assert.equal(observedCall?.arguments?.context?.metadata?.completionAttemptToken, passed.attemptToken);

  policy.putAdminPolicy({ permissions: { allow: ["hook.mcp.call"], deny: ["hook.mcp.call"] }, sandbox }, 2);
  await assert.rejects(runGate("mcp-permission-denied"), /permission denied|hook\.mcp\.call/i); assert.equal(toolCalls, 1, "permission denial must happen before MCP dispatch");

  policy.putAdminPolicy({ permissions: { allow: ["hook.mcp.call"], deny: [] }, sandbox }, 3);
  writeSignedMcpPlugin({ pluginsDir, privateKey, origin, serverId: "missing-server", failureMode: "open", version: "2" }); reloadExternalPlugins(); const warning = await runGate("mcp-unknown-open"); assert.equal(warning.status, "passed_with_warnings"); assert.match(warning.warnings[0]?.error || "", /not configured|missing-server/i); assert.equal(toolCalls, 1);
  writeSignedMcpPlugin({ pluginsDir, privateKey, origin, serverId: "missing-server", failureMode: "closed", version: "3" }); reloadExternalPlugins(); await assert.rejects(runGate("mcp-unknown-closed"), /not configured|missing-server/i); assert.equal(toolCalls, 1);
});

test("one websocket run reruns quality after a queued mutating turn and cannot report success when the second attempt fails", async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "g006-runtime-queued-")); const workspace = path.join(outer, "workspace"); const adminPath = path.join(outer, "admin.json"); fs.mkdirSync(workspace);
  const oldAdmin = process.env.CREWFORGE_ADMIN_POLICY; process.env.CREWFORGE_ADMIN_POLICY = adminPath; clearAgentHooksForTests(); clearCompletionGateCacheForTests(); new ExtensionPolicyStore(workspace, adminPath).putAdminPolicy({ permissions: { allow: ["*"], deny: [] }, sandbox: { readPaths: ["."], writePaths: ["."], networkOrigins: [], secretEnv: [] } }, 1);
  let releaseFirst!: () => void; const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; }); let qualityCalls = 0;
  const unregister = registerAgentHooks({ name: "queued-quality", failureMode: "closed", handlers: { repositoryQuality: async () => { qualityCalls += 1; if (qualityCalls === 1) { await firstRelease; return; } throw new Error("queued mutation failed quality"); } } });
  const originalFetch = globalThis.fetch; let modelCalls = 0;
  globalThis.fetch = async (_input, init) => {
    const body = String(init?.body || "");
    if (body.includes("Generate a concise title") || body.includes("title_runtime")) return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Queued mutation" } }] });
    modelCalls += 1;
    if (modelCalls === 2) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "queued-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "queued.txt", content: "mutated by queued turn\n" }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    if (modelCalls <= 3) return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: modelCalls === 1 ? "first complete" : "second complete" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    throw new Error(`Unexpected model call ${modelCalls}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; unregister(); clearCompletionGateCacheForTests(); clearAgentHooksForTests(); oldAdmin === undefined ? delete process.env.CREWFORGE_ADMIN_POLICY : process.env.CREWFORGE_ADMIN_POLICY = oldAdmin; fs.rmSync(outer, { recursive: true, force: true }); });

  const ws = new FakeSocket(); handleChatWs(ws as unknown as WebSocket, sessionFor(workspace));
  ws.emit("message", Buffer.from(JSON.stringify({ type: "message", requestId: "first-turn", message: "finish first", mode: "code", modelName: config.modelName })));
  await waitFor(() => qualityCalls === 1 && ws.frames.some((frame) => frame.type === "conversation"), 5_000, () => ws.frames);
  const conversationId = ws.frames.find((frame) => frame.type === "conversation")?.conversationId as string; const running = ws.frames.find((frame) => frame.type === "run_state" && frame.status === "running"); assert.ok(conversationId); assert.ok(running?.runId);
  ws.emit("message", Buffer.from(JSON.stringify({ type: "tool_approval_all", conversationId })));
  ws.emit("message", Buffer.from(JSON.stringify({ type: "message", requestId: "queued-turn", conversationId, message: "write queued file", mode: "code", modelName: config.modelName })));
  await waitFor(() => ws.frames.some((frame) => frame.type === "steering" && frame.requestId === "queued-turn"), 5_000, () => ws.frames); releaseFirst();
  await waitFor(() => ws.frames.some((frame) => frame.type === "run_state" && frame.status === "failed"), 5_000, () => ws.frames);

  const failed = ws.frames.find((frame) => frame.type === "run_state" && frame.status === "failed"); const summary = ws.frames.find((frame) => frame.type === "summary" && frame.runId === running.runId);
  assert.equal(qualityCalls, 2); assert.equal(modelCalls, 3); assert.equal(failed.runId, running.runId, "queued turn must remain inside the same websocket run"); assert.equal(failed.qualityGate?.status, "blocked"); assert.notEqual(failed.completionEvidence?.outcome, "completed"); assert.ok(failed.completionEvidence?.ledger?.blockers?.includes("quality")); assert.notEqual(summary?.completionEvidence?.outcome, "completed"); assert.ok(summary?.completionEvidence?.ledger?.blockers?.includes("quality")); assert.equal(summary?.qualityGate?.status, "blocked");
  assert.equal(fs.readFileSync(path.join(workspace, "queued.txt"), "utf8"), "mutated by queued turn\n"); assert.ok(ws.frames.some((frame) => frame.type === "tool_result" && frame.requestId === "queued-turn" && frame.name === "write_file" && frame.isError === false)); assert.ok(ws.frames.some((frame) => frame.type === "done" && frame.requestId === "first-turn")); assert.equal(ws.frames.some((frame) => frame.type === "done" && frame.requestId === "queued-turn"), false);
});

test("policy routes reject viewer/member PUT and explain only server-resolved signed layers despite spoofed client layers", async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "g006-runtime-routes-")); const workspace = path.join(outer, "workspace"); const pluginsDir = path.join(outer, "plugins"); const adminPath = path.join(outer, "admin.json"); fs.mkdirSync(workspace); fs.mkdirSync(pluginsDir);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); const oldPluginsDir = config.pluginsDir; const oldAdmin = process.env.CREWFORGE_ADMIN_POLICY; const oldKeys = process.env.CREWFORGE_PLUGIN_TRUST_KEYS; config.pluginsDir = pluginsDir; process.env.CREWFORGE_ADMIN_POLICY = adminPath; process.env.CREWFORGE_PLUGIN_TRUST_KEYS = JSON.stringify({ "runtime-key": publicKey.export({ type: "spki", format: "pem" }).toString() });
  t.after(() => { setTeamManagerForTests(null); clearAgentHooksForTests(); config.pluginsDir = oldPluginsDir; oldAdmin === undefined ? delete process.env.CREWFORGE_ADMIN_POLICY : process.env.CREWFORGE_ADMIN_POLICY = oldAdmin; oldKeys === undefined ? delete process.env.CREWFORGE_PLUGIN_TRUST_KEYS : process.env.CREWFORGE_PLUGIN_TRUST_KEYS = oldKeys; fs.rmSync(outer, { recursive: true, force: true }); });
  const fakeOrigin = "https://hooks.example.test"; const sandbox = { readPaths: ["."], writePaths: [], networkOrigins: [fakeOrigin], secretEnv: [] }; const policy = new ExtensionPolicyStore(workspace, adminPath); policy.putAdminPolicy({ permissions: { allow: ["hook.http.request"], deny: [] }, sandbox }, 1); policy.putWorkspaceOverride({ permissions: { allow: [], deny: [] }, sandbox: { readPaths: [], writePaths: [], networkOrigins: [], secretEnv: [] } }, 0);
  writeSignedPlugin({ pluginsDir, origin: fakeOrigin, privateKey, failureMode: "open", blocksCompletion: false }); reloadExternalPlugins();
  const manager = new TeamManager(outer); setTeamManagerForTests(manager); const team = manager.createTeam({ username: "owner", teamName: "Policy", workspaceDir: workspace }); for (const [username, role] of [["member", "member"], ["viewer", "viewer"]] as const) { const invite = manager.createInvite(team.id, "owner", role); manager.joinTeamByInvite(invite.code, username); }
  const sessions = new Map<string, UserSession>([["owner", sessionFor(workspace, "owner")], ["member", sessionFor(workspace, "member")], ["viewer", sessionFor(workspace, "viewer")]]); for (const current of sessions.values()) setActiveTeamId(current, team.id);
  const app = express(); app.use(express.json()); app.use((req: any, _res, next) => { req.userSession = sessions.get(String(req.get("x-user") || "owner")); next(); }); app.use("/api/extension-policy", extensionsPolicyRouter); const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve()))); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/extension-policy`;
  for (const username of ["member", "viewer"]) { for (const route of ["workspace", "admin"]) { const response = await fetch(`${base}/${route}`, { method: "PUT", headers: { "content-type": "application/json", "x-user": username, "if-match": route === "admin" ? "2" : "1" }, body: JSON.stringify({ permissions: { allow: ["hook.http.request"] }, sandbox }) }); assert.equal(response.status, 403, `${username}:${route}`); } }
  const explain = await fetch(`${base}/explain`, { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ permission: "hook.http.request", pluginId: "signed-runtime", hookId: "quality", layers: [{ id: "client-spoof", allow: ["*"] }], sandboxLayers: [sandbox] }) }); assert.equal(explain.status, 200); const payload = await explain.json() as any; assert.equal(payload.explanation.allowed, false); assert.equal(payload.explanation.layers.some((layer: any) => layer.id === "client-spoof"), false); assert.deepEqual(payload.explanation.layers.map((layer: any) => layer.id), ["admin", "plugin:signed-runtime", "hook:signed-runtime:quality", "workspace"]);
});

test("completion attempts rerun on revision, deduplicate loop and recorder, and reject stale tokens", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-attempt-"));
  clearAgentHooksForTests(); clearCompletionGateCacheForTests();
  let calls = 0; let reject = false;
  const unregister = registerAgentHooks({ name: "attempt-quality", failureMode: "closed", handlers: { repositoryQuality: () => { calls += 1; if (reject) throw new Error("revised turn failed quality"); } } });
  t.after(() => { unregister(); clearCompletionGateCacheForTests(); clearAgentHooksForTests(); fs.rmSync(workspace, { recursive: true, force: true }); });

  const recorder = new AgentRunRecorder(workspace, "dedupe-run", "conversation", "code"); await recorder.start();
  const messages = await withModelFetch(() => runAgentLoop(new FakeSocket() as unknown as WebSocket, "finish once", "dedupe-turn", sessionFor(workspace), undefined, undefined, undefined, undefined, undefined, undefined, { isStopped: () => false, createAbortSignal: () => undefined, mode: "ask", modelName: "test-model", conversationId: recorder.conversationId, runRecorder: recorder }));
  const finished = await recorder.finish("completed");
  assert.equal(messages.at(-1)?.content, "done"); assert.equal(finished.status, "completed"); assert.equal(calls, 1, "one completion attempt must execute hooks only once across loop and recorder");

  const runId = "queued-run"; const first = beginCompletionAttempt({ workspaceDir: workspace, runId });
  await runRepositoryCompletionGate({ workspaceDir: workspace, runId, attemptToken: first, agentId: "code" });
  reject = true;
  const second = beginCompletionAttempt({ workspaceDir: workspace, runId });
  assert.throws(() => assertCompletionGateToken(workspace, `run:${runId}`, first), /required/);
  await assert.rejects(runRepositoryCompletionGate({ workspaceDir: workspace, runId, attemptToken: second, agentId: "code" }), /revised turn failed quality/);
  assert.equal(calls, 3, "a queued/revised turn must receive a fresh attempt and rerun hooks");

  const stale = beginCompletionAttempt({ workspaceDir: workspace, runId: "restart-run" });
  clearCompletionGateCacheForTests();
  await assert.rejects(runRepositoryCompletionGate({ workspaceDir: workspace, runId: "restart-run", attemptToken: stale, agentId: "code" }), /missing, stale/);
});
