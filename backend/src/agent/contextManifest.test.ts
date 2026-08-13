import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContextManifest } from "./contextManifest.js";
import {
  ContextPreferencesVersionConflictError,
  listContextManifests,
  prepareContextManifest,
  readContextManifest,
  readContextPreferences,
  updateContextPreferences,
} from "./contextManifestStore.js";
import { processModelTurn } from "./modelProcessor.js";
import { compactMessages } from "./context.js";

function workspace(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("persists metadata-only manifests for the exact redacted provider payload", () => {
  const root = workspace("crewforge-context-manifest-");
  try {
    const secret = "sk-test_CONTEXT_CANARY_123456";
    const manifest = buildContextManifest({
      providerId: "openai-compatible",
      modelName: "test-model",
      audit: { storeWorkspaceDir: root, scope: { kind: "workspace", scopeId: "workspace" }, purpose: "agent_turn", agentId: "code", runId: "run-1", requestId: "request-1" },
      systemPrompt: `token=${secret}`,
      messages: [{ role: "user", content: `fix code token=${secret}` }],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
    });
    prepareContextManifest(root, manifest);
    const raw = fs.readFileSync(path.join(root, ".history", "context-manifests", `${manifest.manifestId}.json`), "utf8");
    assert.doesNotMatch(raw, new RegExp(secret));
    assert.doesNotMatch(raw, /fix code/);
    assert.doesNotMatch(raw, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const stored = readContextManifest(root, manifest.manifestId);
    assert.equal(stored.items.length, 3);
    assert.equal(stored.payloadDigest.length, 64);
    assert.equal(stored.scope.auditWorkspaceId.length, 64);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("preferences use CAS and cannot pin mandatory protected sources", () => {
  const root = workspace("crewforge-context-preferences-");
  try {
    const first = updateContextPreferences(root, "conversation-1", { expectedVersion: 0, pins: [{ path: "src/app.ts" }], excludes: ["docs/**"] });
    assert.equal(first.version, 1);
    assert.equal(readContextPreferences(root, "conversation-1").pins[0]?.path, "src/app.ts");
    assert.throws(() => updateContextPreferences(root, "conversation-1", { expectedVersion: 0, excludes: [] }), ContextPreferencesVersionConflictError);
    assert.throws(() => updateContextPreferences(root, "conversation-1", { expectedVersion: 1, pins: [{ path: ".env" }] }), /not authorized: secret/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("existing corrupt context persistence fails closed without rewriting evidence", () => {
  const root = workspace("crewforge-context-corrupt-");
  try {
    const preference = path.join(root, ".history", "context-preferences", "conversation-1.json");
    fs.mkdirSync(path.dirname(preference), { recursive: true }); fs.writeFileSync(preference, "{corrupt-preferences");
    assert.throws(() => readContextPreferences(root, "conversation-1"), (error: unknown) => (error as { code?: string }).code === "context_persistence_invalid");
    assert.equal(fs.readFileSync(preference, "utf8"), "{corrupt-preferences");
    const manifest = path.join(root, ".history", "context-manifests", "bad.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true }); fs.writeFileSync(manifest, "{corrupt-manifest");
    assert.throws(() => listContextManifests(root), (error: unknown) => (error as { code?: string }).code === "context_persistence_invalid");
    assert.equal(fs.readFileSync(manifest, "utf8"), "{corrupt-manifest");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("managed worktree scopes remain distinct and workspace scope cannot cross roots", () => {
  const root = workspace("crewforge-context-scope-root-");
  const child = workspace("crewforge-context-scope-child-");
  try {
    const base = { providerId: "openai-compatible", modelName: "model", messages: [{ role: "user" as const, content: "inspect" }] };
    const one = buildContextManifest({ ...base, audit: { storeWorkspaceDir: root, effectiveWorkspaceDir: child, scope: { kind: "managed_worktree", scopeId: "worktree-one", worktreeId: "worktree-one" }, purpose: "subagent", agentId: "subagent" } });
    const two = buildContextManifest({ ...base, audit: { storeWorkspaceDir: root, effectiveWorkspaceDir: child, scope: { kind: "managed_worktree", scopeId: "worktree-two", worktreeId: "worktree-two" }, purpose: "subagent", agentId: "subagent" } });
    assert.notEqual(one.scope.effectiveScopeId, two.scope.effectiveScopeId);
    assert.throws(() => buildContextManifest({ ...base, audit: { storeWorkspaceDir: root, effectiveWorkspaceDir: child, scope: { kind: "workspace", scopeId: "workspace" }, purpose: "agent_turn", agentId: "code" } }), /cannot cross/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(child, { recursive: true, force: true }); }
});

test("provider retries update one logical manifest and preparation failures block egress", async (t) => {
  const root = workspace("crewforge-context-provider-");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return calls === 1 ? new Response("busy", { status: 503 }) : Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 7 } }); };
  t.after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
  const result = await processModelTurn({ apiUrl: "http://provider.test/v1", model: "model", messages: [{ role: "user", content: "hello" }], fallbackMaxOutputTokens: 100, maxOutputTokens: 100, retryBaseDelayMs: 0, contextAudit: { storeWorkspaceDir: root, scope: { kind: "workspace", scopeId: "workspace" }, purpose: "agent_turn", agentId: "code", runId: "run-1" } });
  assert.equal(calls, 2);
  assert.equal(result.contextManifest.status, "completed");
  assert.equal(result.contextManifest.attempts.length, 2);
  assert.equal(result.contextManifest.actualPromptTokens, 7);
  assert.equal(listContextManifests(root, { runId: "run-1" }).length, 1);
  await assert.rejects(processModelTurn({ apiUrl: "http://provider.test/v1", model: "model", messages: [{ role: "user", content: "blocked" }], fallbackMaxOutputTokens: 100, maxOutputTokens: 100, contextAudit: { storeWorkspaceDir: path.join(root, "missing"), scope: { kind: "workspace", scopeId: "workspace" }, purpose: "agent_turn", agentId: "code" } }), /unavailable/);
  assert.equal(calls, 2, "provider must not be called when manifest preparation fails");
});

test("a prepared-manifest observer failure blocks provider egress", async (t) => {
  const root = workspace("crewforge-context-observer-");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { role: "assistant", content: "unexpected" }, finish_reason: "stop" }] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(processModelTurn({
    apiUrl: "http://provider.test/v1",
    model: "model",
    messages: [{ role: "user", content: "hello" }],
    fallbackMaxOutputTokens: 100,
    maxOutputTokens: 100,
    contextAudit: {
      storeWorkspaceDir: root,
      scope: { kind: "workspace", scopeId: "workspace" },
      purpose: "agent_turn",
      agentId: "code",
    },
    onContextManifest: () => { throw new Error("run attachment failed"); },
  }), /run attachment failed/);

  assert.equal(calls, 0);
  assert.equal(listContextManifests(root)[0]?.status, "failed");
  assert.equal(listContextManifests(root)[0]?.errorCode, "manifest_observer");
});

test("included protected source paths fail closed before persistence", () => {
  const root = workspace("crewforge-context-policy-");
  try {
    assert.throws(() => buildContextManifest({ providerId: "openai-compatible", modelName: "model", messages: [{ role: "user", content: "contents" }], audit: { storeWorkspaceDir: root, scope: { kind: "workspace", scopeId: "workspace" }, purpose: "agent_turn", agentId: "code", messageSources: [{ kind: "editor_context", sourceType: "user_editor_buffer", reason: "explicit", path: ".history/secret.json", trust: "authenticated_user" }] } }), /not authorized: protected/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("compaction transcripts are redacted and the summarizer request is manifested", async (t) => {
  const root = workspace("crewforge-context-compaction-");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { role: "assistant", content: "Objective: continue safely" }, finish_reason: "stop" }] });
  t.after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
  const secret = "sk-test_TRANSCRIPT_CANARY_123456";
  const result = await compactMessages({ workspaceDir: root, messages: [{ role: "user", content: `token=${secret}` }, { role: "assistant", content: "working" }], apiUrl: "http://provider.test/v1", model: "model" });
  assert.doesNotMatch(fs.readFileSync(path.join(root, result.transcriptPath), "utf8"), new RegExp(secret));
  assert.equal(listContextManifests(root)[0]?.purpose, "compaction");
});
