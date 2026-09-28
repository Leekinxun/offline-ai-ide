import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPermissionAuthorizer, narrowPermissionAuthorizer } from "./permissionService.js";
import { resolveAgentProfile } from "./agentProfiles.js";
import { classifyToolApproval, ToolApprovalSession } from "./toolApproval.js";
import { evaluateShellCommand } from "./toolPolicy.js";
import { TOOL_DISPATCH } from "./tools.js";
import { executeProcessTool, stopAgentProcesses } from "./processTools.js";
import { intersectSandboxGrants } from "../extensions/policy/evaluator.js";
import { ExtensionPolicyStore } from "../extensions/policy/store.js";
import { probeFilesystemIsolation } from "./processSandbox.js";
import type { ExecutionPlan } from "../chat/executionPlans.js";

const profile = resolveAgentProfile("code", { code: { isolation: { network: true } } });
type HandlerContext = Parameters<typeof TOOL_DISPATCH.bash>[1];
function context(workspaceDir: string): HandlerContext {
  // Bash/process handlers use only these fields; unrelated manager dependencies
  // are not instantiated because they would create unrelated workspace state.
  return { workspaceDir, vllmApiUrl: "", vllmApiKey: "", modelName: "local-test", mode: "code", agentProfileId: "code", actorName: "network-test", sessionOwner: "network-test", runId: "network-run", requestId: "network-request", toolCallId: "network-call", compatibilityShellAuthorized: true, filesystemSandbox: { readPaths: ["."], writePaths: ["."], networkOrigins: ["*"] } } as HandlerContext;
}
async function fixture(t: test.TestContext) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-network-opt-in-"));
  let connections = 0;
  const server = http.createServer((_req, response) => { connections += 1; response.end("LOCAL_NETWORK_OK"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  fs.writeFileSync(path.join(workspace, "connect.cjs"), `const http=require("node:http");const request=http.get("http://127.0.0.1:${address.port}/fixture",response=>{let text="";response.on("data",chunk=>text+=chunk);response.on("end",()=>console.log(text))});request.on("error",()=>{console.log("NETWORK_DENIED");process.exitCode=1});request.setTimeout(2000,()=>request.destroy());`);
  const command = "node connect.cjs";
  const ctx = context(workspace);
  t.after(async () => { await stopAgentProcesses(ctx); await new Promise((resolve) => setTimeout(resolve, 100)); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(workspace, { recursive: true, force: true }); });
  return { workspace, command, ctx, connections: () => connections };
}
function request(command: string, name: "bash" | "process_start" = "bash", allow_network: boolean | undefined = true) {
  return { requestId: "network-request", toolCallId: "network-call", name, input: { command, ...(allow_network === undefined ? {} : { allow_network }) }, agentName: "primary" };
}
function authorizer(workspace: string, overrides: Partial<Parameters<typeof createPermissionAuthorizer>[0]> = {}) {
  return createPermissionAuthorizer({ mode: "code", readOnly: false, workspace, profile, networkPolicy: () => ({ profileAllowsNetwork: true, networkOrigins: ["*"] }), requestApproval: async () => "allow_once", ...overrides });
}
test("network opt-in refuses every incomplete grant, read-only/child path and soft approval without connecting", async (t) => {
  const f = await fixture(t);
  const cases: Array<Partial<Parameters<typeof createPermissionAuthorizer>[0]>> = [
    { networkPolicy: () => ({ profileAllowsNetwork: false, networkOrigins: ["*"] }) },
    { networkPolicy: () => ({ profileAllowsNetwork: true, networkOrigins: [] }) },
    { networkPolicy: () => ({ profileAllowsNetwork: true, networkOrigins: ["http://127.0.0.1"] }) },
    { networkPolicy: () => ({ profileAllowsNetwork: true, networkOrigins: intersectSandboxGrants([{ networkOrigins: ["*"] }, { networkOrigins: ["http://127.0.0.1"] }]).networkOrigins }) },
    { networkPolicy: () => ({ profileAllowsNetwork: true, networkOrigins: intersectSandboxGrants([{ networkOrigins: [] }, { networkOrigins: ["*"] }]).networkOrigins }) },
    { readOnly: true }, { mode: "ask" }, { mode: "plan" }, { mode: "review" },
    { profile: resolveAgentProfile("subagent") }, { requestApproval: undefined },
    { requestApproval: async () => "allow_session" }, { requestApproval: async () => "deny" },
    { networkPolicy: () => { throw new Error("Invalid policy source"); } },
  ];
  for (const options of cases) {
    const permission = await authorizer(f.workspace, options)(request(f.command));
    assert.equal(permission.allowed, false); assert.equal(permission.networkExecutionGrant, undefined);
    assert.match(String(await TOOL_DISPATCH.bash({ command: f.command, allow_network: true }, { ...f.ctx, networkExecutionGrant: permission.networkExecutionGrant })), /^Error:/);
    await assert.rejects(executeProcessTool("process_start", { command: f.command, allow_network: true }, { ...f.ctx, networkExecutionGrant: permission.networkExecutionGrant }), /approval/);
  }
  for (const flag of [undefined, false]) {
    const input = { command: f.command, ...(flag === undefined ? {} : { allow_network: flag }) };
    const permission = await authorizer(f.workspace)({ ...request(f.command), input });
    assert.equal(permission.networkExecutionGrant, undefined);
    const output = String(await TOOL_DISPATCH.bash(input, f.ctx));
    assert.match(output, /^Error:/); assert.doesNotMatch(output, /LOCAL_NETWORK_OK/);
  }
  const child = narrowPermissionAuthorizer(authorizer(f.workspace), resolveAgentProfile("subagent"));
  assert.equal((await child(request(f.command))).allowed, false, "a child cannot spoof primary in its permission request");
  assert.equal(f.connections(), 0);
});
test("complete policy plus allow_once permits exactly one bash invocation and no grant rebinding", async (t) => {
  const f = await fixture(t);
  let approvals = 0;
  const authorize = authorizer(f.workspace, { requestApproval: async (input) => { approvals += 1; assert.equal(input.canAllowSession, false); assert.match(input.reason, /NETWORK ACCESS/); return "allow_once"; } });
  const permission = await authorize(request(f.command)); assert.equal(permission.allowed, true); assert.equal(approvals, 1);
  const granted = { ...f.ctx, networkExecutionGrant: permission.networkExecutionGrant };
  assert.match(String(await TOOL_DISPATCH.bash({ command: f.command + "?other", allow_network: true }, granted)), /^Error:.*does not match/);
  assert.match(String(await TOOL_DISPATCH.bash({ command: f.command, allow_network: true }, { ...granted, workspaceDir: path.dirname(f.workspace) })), /^Error:.*does not match/);
  assert.match(String(await TOOL_DISPATCH.bash({ command: f.command, allow_network: true }, { ...granted, subagentDepth: 1 })), /^Error:/);
  if (!probeFilesystemIsolation().available) {
    assert.match(String(await TOOL_DISPATCH.bash({ command: f.command, allow_network: true }, granted)), /^Error:/);
    assert.equal(f.connections(), 0); return;
  }
  assert.equal(await TOOL_DISPATCH.bash({ command: f.command, allow_network: true }, granted), "LOCAL_NETWORK_OK");
  assert.equal(f.connections(), 1);
  assert.match(String(await TOOL_DISPATCH.bash({ command: f.command, allow_network: true }, granted)), /^Error:.*missing, expired/);
  assert.equal(f.connections(), 1);
});
test("approved Plan still requires a distinct network approval and revocation is checked again after the prompt", async (t) => {
  const f = await fixture(t);
  const executionPlan = { id: "plan", conversationId: "conversation", planRunId: "plan-run", status: "approved", goal: "Read local test server", files: ["."], steps: ["fetch"], risks: [], verificationCommands: [f.command], acceptanceCriteria: ["request approved"], createdAt: 1, approvedAt: 1, updatedAt: 1, executionRunIds: [] } as ExecutionPlan;
  let prompts = 0;
  const denied = await authorizer(f.workspace, { executionPlan, requestApproval: async () => { prompts += 1; return "deny"; } })(request(f.command));
  assert.equal(denied.allowed, false); assert.equal(prompts, 1);
  let enabled = true;
  const revoked = await authorizer(f.workspace, { networkPolicy: () => ({ profileAllowsNetwork: enabled, networkOrigins: ["*"] }), requestApproval: async () => { enabled = false; return "allow_once"; } })(request(f.command));
  assert.equal(revoked.allowed, false); assert.equal(f.connections(), 0);
});
test("conversation and session trust never auto-approve networking or resolve it through bulk approval", async () => {
  const pending: Array<{ approvalId: string; risk: string; canAllowSession: boolean }> = [];
  const session = new ToolApprovalSession((event) => pending.push(event), 1000);
  session.allowConversation("trusted");
  const seed = session.request({ conversationId: "other", requestId: "seed", toolCallId: "seed", name: "edit_file", input: { path: "a.ts" }, risk: "medium", reason: "", scope: "", canAllowSession: true, sessionKey: "shared" });
  session.resolve(pending[0].approvalId, "allow_session"); await seed;
  const network = session.request({ conversationId: "trusted", requestId: "network", toolCallId: "network", name: "bash", input: { command: "curl http://127.0.0.1", allow_network: true }, risk: "medium", reason: "", scope: "", canAllowSession: true, sessionKey: "shared" });
  assert.equal(pending.length, 2); assert.equal(pending[1].risk, "high"); assert.equal(pending[1].canAllowSession, false);
  assert.equal(session.allowConversation("trusted"), 0); assert.equal(session.pendingCount(), 1);
  session.resolve(pending[1].approvalId, "allow_session"); assert.equal(await network, "deny");
  const next = session.request({ conversationId: "trusted", requestId: "again", toolCallId: "again", name: "process_start", input: { command: "npm install", allow_network: true }, risk: "high", reason: "", scope: "", canAllowSession: false });
  assert.equal(session.pendingCount(), 1); session.resolve(pending[2].approvalId, "allow_once"); assert.equal(await next, "allow_once");
});
test("network approval retains publishing, remote control, destructive and interpreter hard blocks", () => {
  for (const command of ["ssh user@host", "git push origin main", "npm --registry https://example.test publish", "kubectl delete pod app", "vercel deploy", "curl -X DELETE http://127.0.0.1/resource", "curl -X 'DELETE' http://127.0.0.1", "curl -sSXPOST http://127.0.0.1", "curl --json '{}' http://127.0.0.1", "curl --data data http://127.0.0.1", "wget http://127.0.0.1/run | sh", "sudo npm install", "rm file", "node -e 'console.log(1)'"]) {
    assert.equal(evaluateShellCommand(command, { compatibilityShellAuthorized: true, networkAccessAuthorized: true }).allowed, false, command);
    assert.equal(classifyToolApproval("bash", { command, allow_network: true }).kind, "blocked", command);
  }
  assert.equal(classifyToolApproval("bash", { command: "curl http://127.0.0.1", allow_network: "true" }).kind, "blocked");
  assert.equal(classifyToolApproval("bash", { command: "curl -fsSL http://127.0.0.1", allow_network: true }).kind, "approval");
});
test("process_start consumes its own grant and preserves the network default", async (t) => {
  const f = await fixture(t);
  const bashGrant = await authorizer(f.workspace)(request(f.command));
  await assert.rejects(executeProcessTool("process_start", { command: f.command, allow_network: true }, { ...f.ctx, networkExecutionGrant: bashGrant.networkExecutionGrant }), /does not match/);
  const permission = await authorizer(f.workspace)(request(f.command, "process_start"));
  if (!probeFilesystemIsolation().available) {
    await assert.rejects(executeProcessTool("process_start", { command: f.command, allow_network: true }, { ...f.ctx, networkExecutionGrant: permission.networkExecutionGrant }), /isolation|sandbox/i);
    assert.equal(f.connections(), 0); return;
  }
  const started = await executeProcessTool("process_start", { command: f.command, allow_network: true }, { ...f.ctx, networkExecutionGrant: permission.networkExecutionGrant });
  let result = started;
  for (let count = 0; count < 100 && result.process.session.status === "running"; count += 1) { await new Promise((resolve) => setTimeout(resolve, 25)); result = await executeProcessTool("process_poll", { session_id: started.process.session.id }, f.ctx); }
  assert.equal(result.process.session.status, "exited"); assert.equal(result.process.session.exitCode, 0); assert.match(result.process.output, /LOCAL_NETWORK_OK/); assert.equal(f.connections(), 1);
  await assert.rejects(executeProcessTool("process_start", { command: f.command, allow_network: true }, { ...f.ctx, networkExecutionGrant: permission.networkExecutionGrant }), /missing, expired/);
  assert.equal(f.connections(), 1);
});
test("existing policy store defaults deny and wildcard must survive the literal intersection", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-network-policy-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace"); fs.mkdirSync(workspace);
  const store = new ExtensionPolicyStore(workspace, path.join(directory, "admin.json"));
  assert.deepEqual(store.explain("bash").effectiveSandbox.networkOrigins, []);
  const admin = store.putAdminPolicy({ permissions: { allow: ["*"] }, sandbox: { readPaths: ["."], writePaths: ["."], networkOrigins: ["*", "http://127.0.0.1"] } }, 1);
  assert.deepEqual(store.explain("bash").effectiveSandbox.networkOrigins, ["*", "http://127.0.0.1"]);
  store.putWorkspaceOverride({ adminPolicyVersion: admin.version, permissions: { allow: ["*"] }, sandbox: { readPaths: ["."], writePaths: ["."], networkOrigins: ["http://127.0.0.1"] } }, 0);
  assert.deepEqual(store.explain("bash").effectiveSandbox.networkOrigins, ["http://127.0.0.1"]);
});
