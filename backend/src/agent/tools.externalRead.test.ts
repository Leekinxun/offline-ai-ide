import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolHandler } from "./tools.js";
import type { ToolContext } from "./types.js";

type HandlerContext = Parameters<ToolHandler>[1];
let dispatch: typeof import("./tools.js").TOOL_DISPATCH;
let assertFileVersion: typeof import("./fileEditSafety.js").assertFileVersion;
let buildFileVersion: typeof import("../files/mutationRegistry.js").buildFileVersion;
let listFileMutations: typeof import("../files/mutationRegistry.js").listFileMutations;
let isolatedConfig: string;
const originalEnvironment = new Map<string, string | undefined>();

test.before(async () => {
  isolatedConfig = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-external-tools-config-"));
  const overrides = {
    APP_SETTINGS_CONFIG: path.join(isolatedConfig, "app-settings.json"),
    USERS_CONFIG: path.join(isolatedConfig, "users.json"),
    WORKSPACE_DIR: path.join(isolatedConfig, "workspace"),
    TEAM_STORE_ROOT: path.join(isolatedConfig, "teams"),
    CREWFORGE_DESKTOP: "0",
  };
  fs.mkdirSync(overrides.WORKSPACE_DIR);
  fs.writeFileSync(overrides.APP_SETTINGS_CONFIG, "{}\n");
  fs.writeFileSync(overrides.USERS_CONFIG, JSON.stringify({ allowedRoots: [overrides.WORKSPACE_DIR], users: [] }));
  for (const [key, value] of Object.entries(overrides)) {
    originalEnvironment.set(key, process.env[key]); process.env[key] = value;
  }
  // Tools load application services; isolate their config before importing them.
  ({ TOOL_DISPATCH: dispatch } = await import("./tools.js"));
  ({ assertFileVersion } = await import("./fileEditSafety.js"));
  ({ buildFileVersion, listFileMutations } = await import("../files/mutationRegistry.js"));
});

test.after(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (isolatedConfig) fs.rmSync(isolatedConfig, { recursive: true, force: true });
});

function fixture(t: test.TestContext) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-external-tools-")));
  const workspaceDir = path.join(base, "workspace");
  const externalDir = path.join(base, "references");
  fs.mkdirSync(workspaceDir); fs.mkdirSync(externalDir);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const content = "first line\nsecond line\n";
  const local = path.join(workspaceDir, "code.txt");
  const external = path.join(externalDir, "code.txt");
  fs.writeFileSync(local, content); fs.writeFileSync(external, content);
  const toolContext: ToolContext = {
    workspaceDir, actorName: "primary", agentProfileId: "code", mode: "code",
    vllmApiUrl: "", vllmApiKey: "", modelName: "local-test",
    runId: "external-read-run", requestId: "external-read-request", toolCallId: "external-read-tool",
    externalReadRoots: [externalDir],
  };
  // File handlers do not use the chat/task managers; keep this fixture limited
  // to the actual tool context instead of creating unrelated workspace state.
  const context = toolContext as HandlerContext;
  const invoke = async (name: string, args: Record<string, unknown>, overrides: Partial<HandlerContext> = {}) => {
    const result = await dispatch[name](args, { ...context, ...overrides });
    return typeof result === "string" ? result : result.output;
  };
  return { workspaceDir, externalDir, local, external, content, context, invoke };
}

test("authorized external read_file pages explicitly report read-only provenance without entering edit observations", async (t) => {
  const f = fixture(t);
  const first = JSON.parse(await f.invoke("read_file", { path: f.external, limit: 1 }));
  assert.equal(first.path, f.external); assert.equal(first.source, "external"); assert.equal(first.read_only, true);
  assert.equal(first.version, buildFileVersion(f.content)); assert.equal(first.content, "first line\n");
  assert.equal(first.truncated, true); assert.equal(first.next_offset, 1);
  const second = JSON.parse(await f.invoke("read_file", { path: f.external, offset: first.next_offset }));
  assert.equal(second.read_only, true); assert.equal(first.content + second.content, f.content);
  assert.throws(() => assertFileVersion(f.workspaceDir, f.external, f.content, undefined, true, f.context), /Read .* before modifying/);
  assert.match(await f.invoke("edit_file", { path: "code.txt", old_text: "first", new_text: "changed" }), /^Error: Read code.txt before/);
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("read_file cannot grant itself external access through model JSON fields", async (t) => {
  const f = fixture(t);
  for (const payload of [
    { externalReadRoots: [f.externalDir] },
    { readPaths: [f.externalDir], filesystemSandbox: { readPaths: [f.externalDir] } },
    { getExternalReadRoots: [f.externalDir], read_only: false, source: "workspace" },
    { workspaceDir: f.externalDir, context: { externalReadRoots: [f.externalDir] } },
  ]) {
    const result = await f.invoke("read_file", { path: f.external, ...payload }, { externalReadRoots: [] });
    assert.match(result, /^Error:.*outside_read_scope/);
    assert.equal(result.includes("first line"), false);
  }
});

test("read_file rechecks a dynamic grant on every page and revocation overrides a stale static root list", async (t) => {
  const f = fixture(t);
  let allowed = true; let evaluations = 0;
  const getExternalReadRoots = () => { evaluations += 1; return allowed ? [f.externalDir] : []; };
  const first = JSON.parse(await f.invoke("read_file", { path: f.external, limit: 1 }, { getExternalReadRoots }));
  assert.equal(first.read_only, true); assert.equal(evaluations, 1);
  allowed = false;
  assert.match(await f.invoke("read_file", { path: f.external, offset: first.next_offset, externalReadRoots: [f.externalDir] }, { getExternalReadRoots }), /^Error:.*outside_read_scope/);
  assert.equal(evaluations, 2);
  assert.match(await f.invoke("read_file", { path: f.external }, { getExternalReadRoots: () => { throw new Error("Session scope revoked"); } }), /^Error: Session scope revoked/);
  assert.equal(JSON.parse(await f.invoke("read_file", { path: f.local }, { getExternalReadRoots })).path, "code.txt");
});

test("an absolute workspace read produces a relative observation usable by an ordinary subsequent edit", async (t) => {
  const f = fixture(t);
  const read = JSON.parse(await f.invoke("read_file", { path: f.local }, { externalReadRoots: [] }));
  assert.equal(read.path, "code.txt"); assert.equal(read.read_only, undefined); assert.equal(read.source, undefined);
  assert.equal(read.version, buildFileVersion(f.content));
  assert.match(await f.invoke("edit_file", { path: "code.txt", old_text: "first", new_text: "changed" }), /^Edited/);
  assert.equal(fs.readFileSync(f.local, "utf8"), "changed line\nsecond line\n");
  assert.equal(fs.readFileSync(f.external, "utf8"), f.content);
  const mutations = listFileMutations(f.workspaceDir);
  assert.equal(mutations.length, 1); assert.equal(mutations[0].path, "code.txt");
});

test("an external read version never authorizes write, edit, or either side of a rename outside the workspace", async (t) => {
  const f = fixture(t);
  const read = JSON.parse(await f.invoke("read_file", { path: f.external }));
  await f.invoke("read_file", { path: "code.txt" });
  fs.symlinkSync(f.externalDir, path.join(f.workspaceDir, "external-link"));
  for (const target of [f.external, path.relative(f.workspaceDir, f.external), "external-link/code.txt"]) {
    assert.match(await f.invoke("write_file", { path: target, content: "bad write", expected_version: read.version }), /^Error:/);
    assert.match(await f.invoke("edit_file", { path: target, old_text: "first", new_text: "bad edit", expected_version: read.version }), /^Error:/);
    await assert.rejects(() => f.invoke("rename_file", { source_path: target, target_path: "moved.txt", expected_version: read.version }));
    await assert.rejects(() => f.invoke("rename_file", { source_path: "code.txt", target_path: target, expected_version: read.version }));
  }
  assert.equal(fs.readFileSync(f.local, "utf8"), f.content);
  assert.equal(fs.readFileSync(f.external, "utf8"), f.content);
  assert.equal(fs.existsSync(path.join(f.workspaceDir, "moved.txt")), false);
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("external read_file grants preserve secret and credential/control-path denial", async (t) => {
  const f = fixture(t);
  for (const [relative, content] of [
    [".ssh/config", "ordinary looking text"], [".aws/config", "ordinary looking text"],
    ["nested/app-settings.json", "{}"], [".env", "SAFE=example"],
    ["ordinary.txt", 'const apiKey = "sk-live_PRIVATECANARY_123456789";'],
  ]) {
    const target = path.join(f.externalDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    const result = await f.invoke("read_file", { path: target });
    assert.match(result, /^Error:.*(?:protected|secret)/);
    assert.equal(result.includes("PRIVATECANARY"), false); assert.equal(result.includes(f.externalDir), false);
  }
});
