import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { assertRepositoryQuality, clearAgentHooksForTests, registerAgentHooks, registerDeclarativeAgentHook, runAgentHooks } from "../agent/agentHooks.js";
import { resolveAgentProfile, resolveEffectiveAgentPolicy } from "../agent/agentProfiles.js";
import { verifyWorkspaceSkillSignature } from "../agent/skills.js";
import { buildSystemPromptBundle } from "../agent/systemPrompt.js";
import { verifyPluginManifestSignature } from "../plugins/registry.js";
import { assertRepositoryCompletionAllowed, executeExtensionHook, validateHookDeclaration } from "../extensions/policy/evaluator.js";
import { ExtensionPolicyStore } from "../extensions/policy/store.js";
import { clearCompletionGateCacheForTests } from "../extensions/policy/completionGate.js";
import { AgentRunRecorder } from "../chat/runHistory.js";
import { TaskManager } from "../agent/taskManager.js";
import { config } from "../config.js";
import { reloadExternalPlugins } from "../plugins/registry.js";
import { extensionsPolicyRouter } from "../routes/extensionsPolicy.js";
import { TeamManager } from "../team/teamManager.js";
import { setTeamManagerForTests } from "../team/sessionBridge.js";
import { probeFilesystemIsolation } from "../agent/processSandbox.js";
import type { ExtensionHookDeclaration, PermissionLayer, SandboxGrant } from "../extensions/policy/types.js";

const permissionLayers: PermissionLayer[] = [
  { id: "admin", allow: ["hook.command.execute", "hook.http.request", "hook.mcp.call"] },
  { id: "signed-extension", allow: ["hook.command.execute", "hook.http.request", "hook.mcp.call"], signed: true },
  { id: "profile", allow: ["hook.command.execute", "hook.http.request", "hook.mcp.call"] },
  { id: "workspace", allow: ["hook.command.execute", "hook.http.request", "hook.mcp.call"] },
];
const sandbox: SandboxGrant = { readPaths: ["."], writePaths: [], networkOrigins: ["https://hooks.example.test"], secretEnv: [] };
const context = (workspaceDir: string) => ({ workspaceDir, actorId: "agent:code", runId: "run-1", requestId: "request-1", payload: { value: 1, token: "sk-test_SECRET_123456789" } });

function declaration(transport: ExtensionHookDeclaration["transport"], permissions: string[], overrides: Partial<ExtensionHookDeclaration> = {}): ExtensionHookDeclaration {
  return { id: "quality", event: "completion.quality", transport, permissions, sandbox, failureMode: "closed", timeoutMs: 100, maxRetries: 0, maxOutputBytes: 4096, ...overrides };
}

test("command, HTTP, and MCP hooks require explicit permission and structured exact transports", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-hooks-"));
  try {
    const command = declaration({ kind: "command", command: "quality", args: ["--json", 1] }, ["hook.command.execute"]);
    let commandInput: unknown;
    const commandResult = await executeExtensionHook(command, context(workspace), permissionLayers, [sandbox, sandbox, sandbox, sandbox], { command: async (input) => { commandInput = input; return { ok: true }; } });
    assert.equal(commandResult.ok, true);
    assert.deepEqual((commandInput as { args: string[] }).args, ["--json", "1"]);
    assert.deepEqual((commandInput as { sandbox: SandboxGrant }).sandbox, sandbox);

    const http = declaration({ kind: "http", url: "https://hooks.example.test/check", method: "POST" }, ["hook.http.request"]);
    let httpInput: any;
    await executeExtensionHook(http, context(workspace), permissionLayers, [sandbox, sandbox, sandbox, sandbox], { http: async (input) => { httpInput = input; return "ok"; } });
    assert.equal(httpInput.url, "https://hooks.example.test/check");
    assert.doesNotMatch(httpInput.body, /sk-test_SECRET/);
    assert.throws(() => validateHookDeclaration(declaration({ kind: "http", url: "https://evil.example.test/check", method: "POST" }, ["hook.http.request"]), sandbox), /origin/);
    assert.throws(() => validateHookDeclaration(declaration({ kind: "http", url: "https://hooks.example.test/check", method: "POST", headers: { authorization: "embedded-secret" } }, ["hook.http.request"]), sandbox), /Sensitive HTTP headers/);

    const mcp = declaration({ kind: "mcp", serverId: "quality-server", toolName: "validate", arguments: { strict: true } }, ["hook.mcp.call"]);
    let mcpInput: any;
    await executeExtensionHook(mcp, context(workspace), permissionLayers, [sandbox, sandbox, sandbox, sandbox], { mcp: async (input) => { mcpInput = input; return { valid: true }; } });
    assert.equal(mcpInput.serverId, "quality-server");
    assert.deepEqual(mcpInput.arguments.strict, true);
    assert.throws(() => validateHookDeclaration(declaration({ kind: "command", command: "x", args: [] }, [])), /permissions/);

    let declarativeCalls = 0;
    const unregister = registerDeclarativeAgentHook(command, { permissionLayers, sandboxLayers: [sandbox, sandbox, sandbox, sandbox], adapters: { command: async () => { declarativeCalls += 1; return "ok"; } } });
    await runAgentHooks("repositoryQuality", { agentId: "code", workspaceDir: workspace });
    unregister();
    assert.equal(declarativeCalls, 1);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("command hooks enforce effective filesystem grants at the OS boundary", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-command-sandbox-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "g006-command-outside-"));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(workspace, "allowed"));
  fs.mkdirSync(path.join(workspace, ".codex"));
  fs.writeFileSync(path.join(outside, "canary"), "outside");
  fs.writeFileSync(path.join(workspace, ".codex", "policy-override.json"), "control");
  const effective: SandboxGrant = { readPaths: ["allowed"], writePaths: ["allowed"], networkOrigins: [], secretEnv: [] };
  const command = declaration({
    kind: "command",
    command: process.execPath,
    args: ["-e", `const fs=require('fs'); const attempt=(p)=>{try{fs.writeFileSync(p,'changed');return 'WROTE'}catch(e){return e.code||'DENIED'}}; process.stdout.write(JSON.stringify({allowed:attempt('allowed/output'),outside:attempt(process.argv[1]),control:attempt('.codex/policy-override.json')}))`, path.join(outside, "canary")],
  }, ["hook.command.execute"], { sandbox: effective, timeoutMs: 5_000 });
  const capability = probeFilesystemIsolation();
  if (!capability.available) {
    await assert.rejects(executeExtensionHook(command, context(workspace), permissionLayers, [effective, effective, effective, effective]), /filesystem isolation unavailable/i);
    return;
  }
  const result = await executeExtensionHook(command, context(workspace), permissionLayers, [effective, effective, effective, effective]);
  assert.equal(result.ok, true);
  const evidence = JSON.parse(String(result.output)) as Record<string, string>;
  assert.equal(evidence.allowed, "WROTE");
  assert.match(evidence.outside, /^(?:EACCES|EPERM)$/);
  assert.match(evidence.control, /^(?:EACCES|EPERM)$/);
  assert.equal(fs.readFileSync(path.join(outside, "canary"), "utf8"), "outside");
  assert.equal(fs.readFileSync(path.join(workspace, ".codex", "policy-override.json"), "utf8"), "control");
});

test("failure mode, timeout, retry, output limits, audit, and completion blocking are enforced", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-failure-"));
  try {
    let attempts = 0; const audit: unknown[] = []; const trace: unknown[] = [];
    const retrying = declaration({ kind: "command", command: "quality", args: [] }, ["hook.command.execute"], { failureMode: "open", maxRetries: 1 });
    const result = await executeExtensionHook(retrying, context(workspace), permissionLayers, [sandbox, sandbox, sandbox, sandbox], { command: async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error("busy"), { transient: true }); return "ok"; }, audit: (entry) => audit.push(entry), trace: (entry) => trace.push(entry) });
    assert.equal(result.attempts, 2); assert.equal(audit.length, 1); assert.equal(trace.length, 1);

    await assert.rejects(executeExtensionHook(declaration({ kind: "command", command: "hang", args: [] }, ["hook.command.execute"], { timeoutMs: 5 }), context(workspace), permissionLayers, [sandbox, sandbox, sandbox, sandbox], { command: async () => new Promise(() => {}) }), /timed out/);
    await assert.rejects(executeExtensionHook(declaration({ kind: "command", command: "large", args: [] }, ["hook.command.execute"], { maxOutputBytes: 2 }), context(workspace), permissionLayers, [sandbox, sandbox, sandbox, sandbox], { command: async () => "oversized" }), /output limit/);
    assert.throws(() => assertRepositoryCompletionAllowed([{ hookId: "repo-quality", event: "completion.quality", ok: false, attempts: 1, durationMs: 1, blocked: true }]), /blocked completion/);

    clearAgentHooksForTests();
    registerAgentHooks({ name: "repository-quality", failureMode: "open", handlers: { repositoryQuality: () => ({ ok: false, blockCompletion: true, reason: "tests failed" }) } });
    const warnings = await assertRepositoryQuality({ agentId: "code", workspaceDir: workspace });
    assert.deepEqual(warnings, [{ name: "repository-quality", error: "tests failed" }]);
  } finally { clearAgentHooksForTests(); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("nested AGENTS instructions use deterministic root-to-deepest precedence and reject symlinks", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-agents-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "g006-outside-"));
  try {
    fs.mkdirSync(path.join(workspace, "packages", "app", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "ROOT_RULE");
    fs.writeFileSync(path.join(workspace, "packages", "AGENTS.md"), "PACKAGE_RULE token=sk-test_HIDE_ME_123456");
    fs.writeFileSync(path.join(workspace, "packages", "app", "AGENTS.md"), "DEEPEST_RULE");
    fs.writeFileSync(path.join(outside, "AGENTS.md"), "OUTSIDE_CANARY");
    fs.symlinkSync(path.join(outside, "AGENTS.md"), path.join(workspace, "packages", "app", "src", "AGENTS.md"));
    const bundle = buildSystemPromptBundle(workspace, "", { scopePath: "packages/app/src/index.ts" });
    assert.ok(bundle.text.indexOf("ROOT_RULE") < bundle.text.indexOf("PACKAGE_RULE"));
    assert.ok(bundle.text.indexOf("PACKAGE_RULE") < bundle.text.indexOf("DEEPEST_RULE"));
    assert.doesNotMatch(bundle.text, /OUTSIDE_CANARY|sk-test_HIDE_ME/);
    assert.deepEqual(bundle.sources.filter((source) => source.kind === "project_instruction").map((source) => source.path), ["AGENTS.md", "packages/AGENTS.md", "packages/app/AGENTS.md"]);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("plugin and skill signatures detect tampering while unsigned manifests are legacy restricted", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const manifest: Record<string, unknown> = { id: "signed", name: "Signed", version: "1", entry: "index.js", permissions: ["chat.render"] };
  const canonical = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signature").sort(([a], [b]) => a.localeCompare(b)))));
  manifest.signature = { algorithm: "ed25519", keyId: "key-1", value: crypto.sign(null, canonical(manifest), privateKey).toString("base64") };
  assert.equal(verifyPluginManifestSignature(manifest, { "key-1": publicPem }).status, "verified");
  manifest.version = "2";
  assert.equal(verifyPluginManifestSignature(manifest, { "key-1": publicPem }).status, "invalid");
  assert.equal(verifyPluginManifestSignature({ id: "legacy" }, {}).status, "legacy-restricted");

  const metadata = { name: "signed-skill", permissions: "read_file" };
  const body = "# Signed skill";
  const payload = Buffer.from(JSON.stringify({ metadata, body }));
  const signedMetadata = { ...metadata, signingKeyId: "key-1", signature: crypto.sign(null, payload, privateKey).toString("base64") };
  assert.equal(verifyWorkspaceSkillSignature(signedMetadata, body, { "key-1": publicPem }), "verified");
  assert.equal(verifyWorkspaceSkillSignature(signedMetadata, `${body}!`, { "key-1": publicPem }), "invalid");
});

test("effective agent policy and versioned workspace CAS cannot expand any authority layer", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-policy-"));
  const adminPath = path.join(workspace, "admin.json");
  try {
    const store = new ExtensionPolicyStore(workspace, adminPath);
    const admin = store.putAdminPolicy({ permissions: { allow: ["read_file", "write_file"] }, sandbox: { readPaths: ["."], writePaths: ["src"], networkOrigins: [], secretEnv: [] } }, 1);
    const narrowed = store.putWorkspaceOverride({ permissions: { allow: ["read_file"] }, sandbox: { readPaths: ["."], writePaths: [], networkOrigins: [], secretEnv: [] } }, 0);
    assert.equal(admin.version, 2); assert.equal(narrowed.version, 1);
    assert.throws(() => store.putWorkspaceOverride({ permissions: { allow: ["read_file"] } }, 0), /version conflict/);
    assert.throws(() => store.putWorkspaceOverride({ permissions: { allow: ["shell.root"] } }, 1), /cannot expand/);
    const profile = resolveAgentProfile("code");
    assert.deepEqual(profile.tools, profile.permissions.allow);
    assert.equal(profile.isolation.mode, "worktree");
    const effective = resolveEffectiveAgentPolicy({ admin: admin.permissions, signedPlugin: { id: "plugin", allow: ["read_file", "write_file"], signed: true }, signedSkill: { id: "skill", allow: ["read_file"], signed: true }, profile, workspace: narrowed.permissions, candidates: ["read_file", "write_file"] });
    assert.deepEqual(effective.permissions, ["read_file"]);
    assert.equal(effective.explain("write_file").allowed, false);
    assert.equal(store.explain("write_file", [{ id: "plugin", allow: ["write_file"], signed: true }]).allowed, false);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

function canonicalManifestForTest(value: Record<string, unknown>): Buffer {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([key]) => key !== "signature").sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : item;
  return Buffer.from(JSON.stringify(normalize(value)));
}

test("signed plugin registry reload wires exactly one real declarative hook and tampering unloads it", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-registry-"));
  const plugins = path.join(workspace, "plugins"); const pluginDir = path.join(plugins, "quality"); fs.mkdirSync(pluginDir, { recursive: true }); fs.writeFileSync(path.join(pluginDir, "index.js"), "export {};\n");
  const adminPath = path.join(workspace, "admin.json");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  fs.writeFileSync(adminPath, JSON.stringify({ schemaVersion: 1, version: 1, permissions: { id: "admin", allow: ["hook.command.execute"], deny: [] }, sandbox: { readPaths: ["."], writePaths: [], networkOrigins: [], secretEnv: [] }, trustedSigningKeys: { quality: publicPem }, updatedAt: new Date().toISOString() }));
  const manifest: Record<string, unknown> = {
    id: "quality", name: "Quality", version: "1", entry: "index.js",
    permissions: ["hook.command.execute"],
    sandbox: { readPaths: ["."], writePaths: [], networkOrigins: [], secretEnv: [] },
    profiles: [{ id: "review", allow: ["hook.command.execute"], sandbox: { readPaths: ["."], writePaths: [], networkOrigins: [], secretEnv: [] } }],
    skills: [{ id: "lint", allow: ["hook.command.execute"], sandbox: { readPaths: ["."], writePaths: [], networkOrigins: [], secretEnv: [] } }],
    hooks: [{
      id: "complete", event: "completion.quality", permissions: ["hook.command.execute"], profileId: "review", skillIds: ["lint"],
      transport: { kind: "command", command: "/usr/bin/false", args: [] },
      sandbox: { readPaths: ["."], writePaths: [], networkOrigins: [], secretEnv: [] },
      failureMode: "open", timeoutMs: 1000, maxRetries: 0, maxOutputBytes: 1000,
    }],
  };
  manifest.signature = { algorithm: "ed25519", keyId: "quality", value: crypto.sign(null, canonicalManifestForTest(manifest), privateKey).toString("base64") };
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest));
  const previousDir = config.pluginsDir; const previousAdmin = process.env.CREWFORGE_ADMIN_POLICY;
  config.pluginsDir = plugins; process.env.CREWFORGE_ADMIN_POLICY = adminPath; clearAgentHooksForTests(); clearCompletionGateCacheForTests();
  try {
    assert.equal(reloadExternalPlugins()[0].hooks.length, 1);
    const first = await import("../extensions/policy/completionGate.js").then(({ beginCompletionAttempt, runRepositoryCompletionGate }) => runRepositoryCompletionGate({ workspaceDir: workspace, runId: "reload-1", attemptToken: beginCompletionAttempt({ workspaceDir: workspace, runId: "reload-1" }), agentId: "code" }));
    assert.equal(first.status, "passed_with_warnings"); assert.equal(first.warnings.length, 1);
    reloadExternalPlugins();
    const second = await import("../extensions/policy/completionGate.js").then(({ beginCompletionAttempt, runRepositoryCompletionGate }) => runRepositoryCompletionGate({ workspaceDir: workspace, runId: "reload-2", attemptToken: beginCompletionAttempt({ workspaceDir: workspace, runId: "reload-2" }), agentId: "code" }));
    assert.equal(second.warnings.length, 1);
    manifest.version = "tampered"; fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest));
    assert.equal(reloadExternalPlugins()[0].signatureStatus, "invalid");
    const unloaded = await import("../extensions/policy/completionGate.js").then(({ beginCompletionAttempt, runRepositoryCompletionGate }) => runRepositoryCompletionGate({ workspaceDir: workspace, runId: "reload-3", attemptToken: beginCompletionAttempt({ workspaceDir: workspace, runId: "reload-3" }), agentId: "code" }));
    assert.equal(unloaded.warnings.length, 0);
  } finally { config.pluginsDir = previousDir; if (previousAdmin === undefined) delete process.env.CREWFORGE_ADMIN_POLICY; else process.env.CREWFORGE_ADMIN_POLICY = previousAdmin; clearAgentHooksForTests(); clearCompletionGateCacheForTests(); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("central completion gate downgrades recorder success and blocks TaskManager terminal completion", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-completion-")); clearAgentHooksForTests(); clearCompletionGateCacheForTests();
  const unregister = registerAgentHooks({ name: "blocking-quality", failureMode: "closed", handlers: { repositoryQuality: () => { throw new Error("quality evidence missing"); } } });
  try {
    const recorder = new AgentRunRecorder(workspace, "run-blocked", "conversation", "code"); await recorder.start();
    const completedEvidence = { schemaVersion: 1 as const, outcome: "completed" as const, ledger: { changedFiles: [], verification: [], criteria: [], blockers: [] } };
    const finished = await recorder.finish("completed", {}, { changedFiles: [], toolCallCount: 0, errorCount: 0, commandCount: 0, completionEvidence: completedEvidence }, completedEvidence);
    assert.equal(finished.status, "failed"); assert.equal(finished.qualityGate?.status, "blocked"); assert.equal(finished.completionEvidence?.outcome, "failed"); assert.deepEqual(finished.completionEvidence?.ledger.blockers, ["quality"]); assert.equal(finished.summary?.qualityGate?.status, "blocked");
    const tasks = new TaskManager(workspace); const task = JSON.parse(tasks.create("quality task")); const lease = tasks.claimLease(task.id, "agent")!;
    assert.throws(() => tasks.complete(task.id, "agent", lease.token), /quality gate is required/);
    await assert.rejects(tasks.completeAfterQualityGate(task.id, "agent", lease.token, [], "task-run"), /quality evidence missing/);
    assert.equal(tasks.getTask(task.id).status, "in_progress");
  } finally { unregister(); clearAgentHooksForTests(); clearCompletionGateCacheForTests(); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("extension policy routes reject viewers and resolve explanation bindings only from server registry", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "g006-route-")); const teamRoot = fs.mkdtempSync(path.join(os.tmpdir(), "g006-team-"));
  const manager = new TeamManager(teamRoot); const team = manager.createTeam({ username: "owner", teamName: "Policy", workspaceDir: workspace }); const invite = manager.createInvite(team.id, "owner", "viewer"); manager.joinTeamByInvite(invite.code, "viewer"); setTeamManagerForTests(manager);
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).userSession = { token: "viewer-token", username: "viewer", workspaceDir: workspace, isAdmin: false, isolated: false }; next(); }); app.use(extensionsPolicyRouter);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address === "object"); const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/workspace`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 0, permissions: { allow: [] }, sandbox: {} }) })).status, 403);
    const fake = await fetch(`${base}/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "hook.command.execute", pluginId: "fake", layers: [{ id: "fake", allow: ["*"] }] }) }); assert.equal(fake.status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); setTeamManagerForTests(null); fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(teamRoot, { recursive: true, force: true }); }
});
