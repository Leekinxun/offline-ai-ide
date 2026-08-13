import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, test } from "node:test";
import { GithubDeliveryProvider } from "../integrations/delivery/providers/github.js";
import { GitlabDeliveryProvider } from "../integrations/delivery/providers/gitlab.js";
import { GiteaDeliveryProvider } from "../integrations/delivery/providers/gitea.js";
import type { DeliveryProviderConfig, RepositoryRef, WriteOperationContext } from "../integrations/delivery/types.js";
import { ProviderHttpClient, ProviderHttpError } from "../integrations/delivery/httpClient.js";
import { DeliveryWebhookError, verifyGiteaWebhook, verifyGithubWebhook, verifyGitlabWebhook } from "../integrations/delivery/webhook.js";
import { DeliveryService, mergeGeneratedBody } from "../integrations/delivery/service.js";
import type { DeliveryProvider } from "../integrations/delivery/types.js";
import { ProviderNetworkError } from "../integrations/delivery/httpClient.js";
import { createArtifactFixture } from "./artifactTestSupport.js";
import { normalizeProviderWebUrl, requireProviderWebUrl } from "../integrations/delivery/providerUrl.js";
import { dispatchDeliveryWebhook, type DeliveryWebhookService } from "../routes/delivery.js";

const TOKEN_ENV = "CROWNFORGE_TEST_DELIVERY_TOKEN";
interface ProviderUrlCorpus {
  schemaVersion: number;
  valid: Array<{ id: string; input: string; allowLoopbackHttp: boolean; expected: string }>;
  invalid: Array<{ id: string; input: string; allowLoopbackHttp: boolean }>;
}
const providerUrlCorpus = JSON.parse(fs.readFileSync(new URL("../../../scripts/fixtures/provider-url-corpus.json", import.meta.url), "utf8")) as ProviderUrlCorpus;
const originalToken = process.env[TOKEN_ENV];
afterEach(() => { if (originalToken === undefined) delete process.env[TOKEN_ENV]; else process.env[TOKEN_ENV] = originalToken; });

async function mockServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>) {
  const requests: Array<{ method: string; url: string; authorization?: string; privateToken?: string; apiVersion?: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ method: req.method || "GET", url: req.url || "", authorization: req.headers.authorization, privateToken: req.headers["private-token"] as string | undefined, apiVersion: req.headers["x-github-api-version"] as string | undefined });
    await handler(req, res, Buffer.concat(chunks).toString("utf8"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("mock server did not bind");
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
function json(res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); }
function context(): WriteOperationContext { return { idempotencyKey: "idem-1", requestDigest: "digest", approvalId: "approval", conversationId: "conversation", runId: "run", worktreeId: "worktree", changeSetId: "changeset", revision: "revision", evidenceLedgerDigest: "evidence" }; }

test("provider HTTP client retries safe reads, never retries writes, and rejects cross-origin pagination", async () => {
  let getAttempts = 0; let postAttempts = 0;
  const fixture = await mockServer((req, res) => {
    if (req.method === "GET") { getAttempts += 1; if (getAttempts === 1) return json(res, { retry: true }, 503, { "retry-after": "0" }); return json(res, { ok: true }); }
    postAttempts += 1; return json(res, { retry: false }, 503);
  });
  try {
    const client = new ProviderHttpClient(fixture.url, { sleep: async () => undefined });
    assert.deepEqual((await client.request<{ ok: boolean }>({ path: "read" })).data, { ok: true });
    await assert.rejects(client.request({ method: "POST", path: "write", body: {} }), ProviderHttpError);
    assert.equal(getAttempts, 2); assert.equal(postAttempts, 1);
    assert.throws(() => client.resolve("https://attacker.invalid/leak"), ProviderHttpError);
  } finally { await fixture.close(); }
});

test("provider web URLs accept only HTTPS and explicit loopback HTTP without parser tricks", () => {
  assert.equal(providerUrlCorpus.schemaVersion, 1);
  assert.equal(new Set([...providerUrlCorpus.valid, ...providerUrlCorpus.invalid].map((entry) => entry.id)).size, providerUrlCorpus.valid.length + providerUrlCorpus.invalid.length);
  for (const entry of providerUrlCorpus.valid) assert.equal(normalizeProviderWebUrl(entry.input, { allowLoopbackHttp: entry.allowLoopbackHttp }), entry.expected, entry.id);
  for (const entry of providerUrlCorpus.invalid) assert.equal(normalizeProviderWebUrl(entry.input, { allowLoopbackHttp: entry.allowLoopbackHttp }), undefined, entry.id);
  assert.throws(() => requireProviderWebUrl(providerUrlCorpus.invalid[0]!.input, "Provider proposal"), /unsafe|malformed/i);
});

test("GitHub provider conforms for probe, create, checks, review feedback, and auth/version headers", async () => {
  process.env[TOKEN_ENV] = "github-secret";
  const fixture = await mockServer((req, res) => {
    const url = req.url || "";
    if (url === "/versions") return json(res, ["2026-03-10"]);
    if (url === "/repos/acme/repo") return json(res, { id: 1 });
    if (req.method === "POST" && url === "/repos/acme/repo/pulls") return json(res, { number: 7, id: 7, html_url: "https://github.test/7", title: "Change", body: "Body", state: "open", head: { ref: "feature", sha: "abc123" }, base: { ref: "main" }, mergeable: true, updated_at: "v1" }, 201);
    if (url.startsWith("/repos/acme/repo/commits/abc123/check-runs")) return json(res, { check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success", head_sha: "abc123", html_url: "https://github.test/checks/1" }] });
    if (url === "/repos/acme/repo/commits/abc123/status") return json(res, { statuses: [{ id: 2, context: "legacy", state: "failure", target_url: "javascript:alert(1)" }] });
    if (url.startsWith("/repos/acme/repo/pulls/7/comments")) return json(res, [{ id: 3, body: "Please fix", html_url: "https://github.test/comments/3", path: "src/a.ts", line: 4, commit_id: "abc123" }]);
    return json(res, { error: url }, 404);
  });
  try {
    const config: DeliveryProviderConfig = { id: "github", kind: "github", baseUrl: fixture.url, tokenEnv: TOKEN_ENV };
    const provider = new GithubDeliveryProvider(config); const repo: RepositoryRef = { providerConfigId: config.id, remoteRepositoryId: "acme/repo", owner: "acme", name: "repo" };
    assert.equal((await provider.probe(repo)).health, "online");
    const created = await provider.createChangeRequest({ repository: repo, title: "Change", body: "Body", headBranch: "feature", baseBranch: "main" }, context());
    assert.equal(created.number, 7); assert.equal(created.url, "https://github.test/7");
    const checks = (await provider.listChecks(repo, "abc123")).items;
    assert.deepEqual(checks.map((item) => item.state), ["success", "failure"]); assert.equal(checks[0]?.url, "https://github.test/checks/1"); assert.equal(checks[1]?.url, undefined);
    const feedback = (await provider.listReviewFeedback({ ...repo, number: 7 })).items[0]; assert.equal(feedback?.path, "src/a.ts"); assert.equal(feedback?.url, "https://github.test/comments/3");
    assert.ok(fixture.requests.every((request) => request.authorization === "Bearer github-secret"));
    assert.ok(fixture.requests.every((request) => request.apiVersion === "2026-03-10"));
  } finally { await fixture.close(); }
});

test("GitLab provider conforms for probe, create, pipelines/statuses, discussions, and private-token auth", async () => {
  process.env[TOKEN_ENV] = "gitlab-secret";
  const fixture = await mockServer((req, res) => {
    const url = req.url || "";
    if (url === "/api/v4/version") return json(res, { version: "19.1.0" });
    if (url === "/api/v4/projects/acme%2Frepo") return json(res, { id: 1 });
    if (req.method === "POST" && url === "/api/v4/projects/acme%2Frepo/merge_requests") return json(res, { iid: 8, id: 8, web_url: "https://gitlab.test/8", title: "Change", description: "Body", state: "opened", source_branch: "feature", target_branch: "main", sha: "abc123", updated_at: "v1", detailed_merge_status: "mergeable" }, 201);
    if (url.startsWith("/api/v4/projects/acme%2Frepo/pipelines")) return json(res, [{ id: 1, status: "success", sha: "abc123", web_url: "https://gitlab.test/pipelines/1" }]);
    if (url.startsWith("/api/v4/projects/acme%2Frepo/repository/commits/abc123/statuses")) return json(res, [{ id: 2, name: "lint", status: "failed", sha: "abc123", target_url: "data:text/html,unsafe" }]);
    if (url.startsWith("/api/v4/projects/acme%2Frepo/merge_requests/8/discussions")) return json(res, [{ notes: [{ id: 3, body: "Please fix", web_url: "https://gitlab.test/notes/3", position: { new_path: "src/a.ts", new_line: 4, head_sha: "abc123" }, author: { username: "reviewer" } }] }]);
    return json(res, { error: url }, 404);
  });
  try {
    const config: DeliveryProviderConfig = { id: "gitlab", kind: "gitlab", baseUrl: fixture.url, tokenEnv: TOKEN_ENV, tokenKind: "private-token" };
    const provider = new GitlabDeliveryProvider(config); const repo: RepositoryRef = { providerConfigId: config.id, remoteRepositoryId: "acme/repo" };
    assert.equal((await provider.probe(repo)).supports.drafts, true);
    const created = await provider.createChangeRequest({ repository: repo, title: "Change", body: "Body", headBranch: "feature", baseBranch: "main" }, context());
    assert.equal(created.number, 8); assert.equal(created.url, "https://gitlab.test/8");
    const checks = (await provider.listChecks(repo, "abc123")).items;
    assert.deepEqual(checks.map((item) => item.state), ["success", "failure"]); assert.equal(checks[0]?.url, "https://gitlab.test/pipelines/1"); assert.equal(checks[1]?.url, undefined);
    const feedback = (await provider.listReviewFeedback({ ...repo, number: 8 })).items[0]; assert.equal(feedback?.author, "reviewer"); assert.equal(feedback?.url, "https://gitlab.test/notes/3");
    assert.ok(fixture.requests.every((request) => request.authorization === undefined && request.privateToken === "gitlab-secret"));
  } finally { await fixture.close(); }
});

test("Gitea provider conforms and falls back from unavailable Actions to commit statuses", async () => {
  process.env[TOKEN_ENV] = "gitea-secret";
  const fixture = await mockServer((req, res) => {
    const url = req.url || "";
    if (url === "/api/v1/version") return json(res, { version: "1.25.2" });
    if (url === "/api/v1/repos/acme/repo") return json(res, { id: 1 });
    if (url.startsWith("/api/v1/repos/acme/repo/actions/runs")) return json(res, { message: "not found" }, 404);
    if (req.method === "POST" && url === "/api/v1/repos/acme/repo/pulls") return json(res, { number: 9, id: 9, html_url: "https://gitea.test/9", title: "Change", body: "Body", state: "open", head: { ref: "feature", sha: "abc123" }, base: { ref: "main" }, mergeable: true, updated_at: "v1" }, 201);
    if (url.startsWith("/api/v1/repos/acme/repo/commits/abc123/statuses")) return json(res, [{ id: 1, context: "test", status: "success", sha: "abc123", target_url: "https://gitea.test/status/1" }]);
    if (url === "/api/v1/repos/acme/repo/issues/9/comments") return json(res, [{ id: 2, body: "Comment", html_url: "file:///tmp/unsafe", user: { login: "reviewer" } }]);
    if (url.startsWith("/api/v1/repos/acme/repo/pulls/9/reviews")) return json(res, [{ id: 3, body: "Approved", state: "APPROVED", html_url: "https://gitea.test/reviews/3", user: { login: "approver" } }]);
    return json(res, { error: url }, 404);
  });
  try {
    const config: DeliveryProviderConfig = { id: "gitea", kind: "gitea", baseUrl: fixture.url, tokenEnv: TOKEN_ENV, tokenKind: "gitea-token" };
    const provider = new GiteaDeliveryProvider(config); const repo: RepositoryRef = { providerConfigId: config.id, remoteRepositoryId: "acme/repo", owner: "acme", name: "repo" };
    const capabilities = await provider.probe(repo); assert.equal(capabilities.health, "online"); assert.equal(capabilities.supports.actions, false);
    const created = await provider.createChangeRequest({ repository: repo, title: "Change", body: "Body", headBranch: "feature", baseBranch: "main" }, context());
    assert.equal(created.number, 9); assert.equal(created.url, "https://gitea.test/9");
    const checks = (await provider.listChecks(repo, "abc123")).items; assert.deepEqual(checks.map((item) => item.state), ["success"]); assert.equal(checks[0]?.url, "https://gitea.test/status/1");
    const feedback = (await provider.listReviewFeedback({ ...repo, number: 9 })).items; assert.deepEqual(feedback.map((item) => item.kind), ["comment", "approval"]); assert.equal(feedback[0]?.url, undefined); assert.equal(feedback[1]?.url, "https://gitea.test/reviews/3");
    assert.ok(fixture.requests.every((request) => request.authorization === "token gitea-secret"));
  } finally { await fixture.close(); }
});

test("all webhook adapters verify raw bytes and reject changed bodies", () => {
  const body = Buffer.from(JSON.stringify({ repository: { full_name: "acme/repo" } })); const changed = Buffer.from(`${body.toString("utf8")} `); const secret = "webhook-secret";
  const githubHeaders = { "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`, "x-github-delivery": "gh-1", "x-github-event": "push" };
  assert.equal(verifyGithubWebhook(body, githubHeaders, secret).deliveryId, "gh-1"); assert.throws(() => verifyGithubWebhook(changed, githubHeaders, secret));
  const timestamp = String(Math.floor(Date.now() / 1_000)); const key = Buffer.from(secret).toString("base64"); const gitlabDigest = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(`gl-1.${timestamp}.`).update(body).digest("base64");
  const gitlabHeaders = { "webhook-signature": `v1,${gitlabDigest}`, "webhook-id": "gl-1", "webhook-timestamp": timestamp, "x-gitlab-event": "Pipeline Hook" };
  assert.equal(verifyGitlabWebhook(body, gitlabHeaders, key).deliveryId, "gl-1"); assert.throws(() => verifyGitlabWebhook(changed, gitlabHeaders, key));
  const giteaHeaders = { "x-gitea-signature": crypto.createHmac("sha256", secret).update(body).digest("hex"), "x-gitea-delivery": "gt-1", "x-gitea-event-type": "push" };
  assert.equal(verifyGiteaWebhook(body, giteaHeaders, secret).deliveryId, "gt-1"); assert.throws(() => verifyGiteaWebhook(changed, giteaHeaders, secret));
});

function webhookService(input: {
  workspace: string;
  secret: string;
  repositoryId: string;
  proposal: number;
  headSha: string;
  feedbackId: string;
}) {
  let sideEffects = 0;
  let polls = 0;
  const receipts = new Set<string>();
  const service: DeliveryWebhookService = {
    workspace: input.workspace,
    verifyWebhook(providerConfigId, _rawBody, headers) {
      if (headers["x-test-secret"] !== input.secret) throw new DeliveryWebhookError("invalid_signature", "Webhook signature rejected");
      return {
        providerConfigId,
        deliveryId: String(headers["x-test-delivery"] || "delivery-1"),
        event: "pull_request_review_comment",
        repositoryId: String(headers["x-test-repository"] || input.repositoryId),
        changeRequestNumber: Number(headers["x-test-proposal"] || input.proposal),
        headSha: String(headers["x-test-head"] || input.headSha),
        feedback: { id: "remote-comment", kind: "inline_comment", body: "Please fix this", path: "src/a.ts", line: 4 },
        receivedAt: 1,
      };
    },
    consumeVerifiedWebhook(event) {
      const exact = event.providerConfigId === "shared-provider"
        && event.repositoryId === input.repositoryId
        && event.changeRequestNumber === input.proposal
        && event.headSha === input.headSha;
      if (!exact) return { consumed: false, duplicate: false, event };
      if (receipts.has(event.deliveryId)) return { consumed: true, duplicate: true, event };
      receipts.add(event.deliveryId);
      sideEffects += 1;
      return { consumed: true, duplicate: false, event, feedback: { id: input.feedbackId } as any };
    },
    async pollAll() { polls += 1; },
  };
  return { service, counts: () => ({ sideEffects, polls }) };
}

test("delivery webhook fans out to every exact workspace binding and replays without duplicate side effects", async () => {
  const first = webhookService({ workspace: "/workspace/one", secret: "shared-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback-one" });
  const second = webhookService({ workspace: "/workspace/two", secret: "shared-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback-two" });
  const headers = { "x-test-secret": "shared-secret", "x-test-delivery": "fanout-1" };

  const accepted = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), headers, [first.service, second.service, first.service]);
  assert.deepEqual(accepted, { status: 202, body: { accepted: true, duplicate: false, feedbackId: "feedback-one", services: { total: 2, verified: 2, verificationFailed: 0, consumed: 2, duplicates: 0, pollSucceeded: 0, pollFailed: 0, internalFailed: 0 } } });
  assert.deepEqual(first.counts(), { sideEffects: 1, polls: 0 });
  assert.deepEqual(second.counts(), { sideEffects: 1, polls: 0 });

  const replay = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), headers, [first.service, second.service]);
  assert.deepEqual(replay, { status: 202, body: { accepted: true, duplicate: true, services: { total: 2, verified: 2, verificationFailed: 0, consumed: 2, duplicates: 2, pollSucceeded: 0, pollFailed: 0, internalFailed: 0 } } });
  assert.deepEqual(first.counts(), { sideEffects: 1, polls: 0 });
  assert.deepEqual(second.counts(), { sideEffects: 1, polls: 0 });
});

test("delivery webhook verifies workspace-specific secrets independently and consumes only exact eligible bindings", async () => {
  const wrongSecret = webhookService({ workspace: "/workspace/wrong-secret", secret: "other-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "wrong-secret-feedback" });
  const eligible = webhookService({ workspace: "/workspace/eligible", secret: "request-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "eligible-feedback" });
  const wrongProposal = webhookService({ workspace: "/workspace/wrong-proposal", secret: "request-secret", repositoryId: "acme/repo", proposal: 43, headSha: "a".repeat(40), feedbackId: "wrong-proposal-feedback" });

  const result = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), { "x-test-secret": "request-secret", "x-test-delivery": "mixed-1", "x-test-proposal": "42" }, [wrongSecret.service, eligible.service, wrongProposal.service]);
  assert.deepEqual(result, { status: 202, body: { accepted: true, duplicate: false, feedbackId: "eligible-feedback", services: { total: 3, verified: 2, verificationFailed: 1, consumed: 1, duplicates: 0, pollSucceeded: 0, pollFailed: 0, internalFailed: 0 } } });
  assert.deepEqual(wrongSecret.counts(), { sideEffects: 0, polls: 0 });
  assert.deepEqual(eligible.counts(), { sideEffects: 1, polls: 0 });
  assert.deepEqual(wrongProposal.counts(), { sideEffects: 0, polls: 0 });
});

test("delivery webhook rejects globally invalid signatures generically and polls on stale exact-head misses", async () => {
  const first = webhookService({ workspace: "/workspace/one", secret: "first-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback-one" });
  const second = webhookService({ workspace: "/workspace/two", secret: "second-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback-two" });

  const invalid = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), { "x-test-secret": "invalid-secret" }, [first.service, second.service]);
  assert.deepEqual(invalid, { status: 401, body: { code: "INVALID_WEBHOOK_SIGNATURE", error: "Webhook signature verification failed", services: { total: 2, verified: 0, verificationFailed: 2, consumed: 0, duplicates: 0, pollSucceeded: 0, pollFailed: 0, internalFailed: 0 } } });
  assert.deepEqual(first.counts(), { sideEffects: 0, polls: 0 });
  assert.deepEqual(second.counts(), { sideEffects: 0, polls: 0 });

  const stale = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), { "x-test-secret": "first-secret", "x-test-delivery": "stale-1", "x-test-head": "b".repeat(40) }, [first.service, second.service]);
  assert.deepEqual(stale, { status: 202, body: { accepted: false, pollFallback: true, retryable: false, services: { total: 2, verified: 1, verificationFailed: 1, consumed: 0, duplicates: 0, pollSucceeded: 1, pollFailed: 0, internalFailed: 0 } } });
  assert.deepEqual(first.counts(), { sideEffects: 0, polls: 1 });
  assert.deepEqual(second.counts(), { sideEffects: 0, polls: 0 });
});

test("delivery webhook separates typed client verification failures from internal configuration failures", async () => {
  const signature = webhookService({ workspace: "/workspace/signature", secret: "expected", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback" });
  const invalidSignature = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), { "x-test-secret": "wrong" }, [signature.service]);
  assert.equal(invalidSignature.status, 401);
  assert.equal(invalidSignature.body.code, "INVALID_WEBHOOK_SIGNATURE");

  const invalidPayloadService = { ...signature.service, workspace: "/workspace/payload", verifyWebhook() { throw new DeliveryWebhookError("invalid_payload", "Webhook body is invalid"); } };
  const invalidPayload = await dispatchDeliveryWebhook("shared-provider", Buffer.from("not-json"), {}, [invalidPayloadService]);
  assert.deepEqual(invalidPayload, { status: 400, body: { code: "INVALID_WEBHOOK", error: "Webhook verification failed", services: { total: 1, verified: 0, verificationFailed: 1, consumed: 0, duplicates: 0, pollSucceeded: 0, pollFailed: 0, internalFailed: 0 } } });

  const missingConfigService = { ...signature.service, workspace: "/workspace/missing-config", verifyWebhook() { throw new Error("Webhook secret environment variable is not configured: SUPER_SECRET"); } };
  const missingConfig = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), {}, [missingConfigService]);
  assert.deepEqual(missingConfig, { status: 500, body: { code: "WEBHOOK_INTERNAL_ERROR", error: "Webhook processing failed", retryable: true, services: { total: 1, verified: 0, verificationFailed: 0, consumed: 0, duplicates: 0, pollSucceeded: 0, pollFailed: 0, internalFailed: 1 } } });
  assert.doesNotMatch(JSON.stringify(missingConfig), /SUPER_SECRET|environment variable/);
});

test("delivery webhook exposes consume persistence failures as secret-safe retryable server errors", async () => {
  const fixture = webhookService({ workspace: "/workspace/persistence", secret: "shared-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback" });
  fixture.service.consumeVerifiedWebhook = () => { throw new Error("provider-persistence-secret"); };
  const result = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), { "x-test-secret": "shared-secret" }, [fixture.service]);
  assert.deepEqual(result, { status: 500, body: { code: "WEBHOOK_INTERNAL_ERROR", error: "Webhook processing failed", retryable: true, services: { total: 1, verified: 1, verificationFailed: 0, consumed: 0, duplicates: 0, pollSucceeded: 0, pollFailed: 0, internalFailed: 1 } } });
  assert.doesNotMatch(JSON.stringify(result), /persistence-secret/);
  assert.deepEqual(fixture.counts(), { sideEffects: 0, polls: 0 });
});

test("delivery webhook polling reports partial failures without leaking errors or creating unhandled rejections", async () => {
  const first = webhookService({ workspace: "/workspace/one", secret: "shared-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback-one" });
  const second = webhookService({ workspace: "/workspace/two", secret: "shared-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback-two" });
  const third = webhookService({ workspace: "/workspace/three", secret: "shared-secret", repositoryId: "acme/repo", proposal: 42, headSha: "a".repeat(40), feedbackId: "feedback-three" });
  second.service.pollAll = async () => { throw new Error("secret-token-and-workspace-two"); };
  third.service.pollAll = async (signal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("timed-out-provider-secret")), { once: true }));
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const result = await dispatchDeliveryWebhook("shared-provider", Buffer.from("{}"), { "x-test-secret": "shared-secret", "x-test-delivery": "miss", "x-test-head": "b".repeat(40) }, [first.service, second.service, third.service], 20);
    assert.deepEqual(result, { status: 503, body: { code: "POLL_FALLBACK_INCOMPLETE", error: "Delivery polling fallback did not complete for every service", accepted: false, pollFallback: true, retryable: true, services: { total: 3, verified: 3, verificationFailed: 0, consumed: 0, duplicates: 0, pollSucceeded: 1, pollFailed: 2, internalFailed: 0 } } });
    assert.doesNotMatch(JSON.stringify(result), /secret-token|workspace\/two/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("scheduled delivery polling records failures, consumes rejections, and retries on the next tick", async (t) => {
  const workspace = fs.mkdtempSync(path.join(process.cwd(), ".tmp-delivery-poll-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const service = new DeliveryService(workspace, { providers: [], pollIntervalSeconds: 1, requestTimeoutSeconds: 1 });
  let callback: (() => void) | undefined;
  let attempts = 0;
  service.pollAll = async () => { attempts += 1; if (attempts === 1) throw new Error("provider-secret"); };
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  t.after(() => { process.off("unhandledRejection", listener); service.stopPolling(); });
  service.startPolling(((handler: () => void) => { callback = handler; return { unref() {} } as NodeJS.Timeout; }) as typeof setInterval);
  callback?.();
  for (let index = 0; index < 20 && service.getPollingStatus().state === "running"; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.getPollingStatus(), { state: "failed", attempt: 1, retryable: true });
  callback?.();
  for (let index = 0; index < 20 && service.getPollingStatus().state === "running"; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.getPollingStatus(), { state: "succeeded", attempt: 2, retryable: false });
  assert.deepEqual(unhandled, []);
});

test("server-owned publication rejects fake approval/binding, enforces idempotency, protects generated blocks, and preserves stale snapshots", async (t) => {
  const fixture = await createArtifactFixture(t); let createCalls = 0; let updateCalls = 0; let offline = false;
  const config: DeliveryProviderConfig = { id: "mock", kind: "github", baseUrl: "https://api.example.test", tokenEnv: TOKEN_ENV };
  const repo: RepositoryRef = { providerConfigId: "mock", remoteRepositoryId: "acme/repo", owner: "acme", name: "repo" };
  let remote = { providerConfigId: "mock", repositoryId: "acme/repo", number: 12, remoteId: "12", url: "https://example.test/12", title: "Change", body: "", state: "open" as const, headBranch: "feature", baseBranch: "main", headSha: fixture.changeSet.headSha, remoteVersion: "v1", mergeReadiness: "ready" as const };
  const provider: DeliveryProvider = {
    kind: "github", config,
    async probe() { return { providerConfigId: "mock", kind: "github", health: "online", authenticated: true, supports: { changeRequests: true, drafts: true, reviewThreads: true, reviewDecisions: true, checks: true, commitStatuses: true, actions: true, webhooks: true, signedWebhooks: true, conditionalGets: true, atomicChangeRequestUpdate: false }, checkedAt: Date.now() }; },
    async findChangeRequests() { return { items: createCalls ? [remote] : [] }; },
    async getChangeRequest() { if (offline) throw new ProviderNetworkError("offline", false); return remote; },
    async createChangeRequest(request) { createCalls += 1; remote = { ...remote, body: request.body }; return remote; },
    async updateChangeRequest(_ref, patch) { updateCalls += 1; remote = { ...remote, body: patch.body || "", title: patch.title || remote.title }; return remote; },
    async listChecks() { return { items: [{ id: "unsafe-check", name: "CI", state: "failure", sha: remote.headSha, url: "data:text/html,unsafe" }] }; },
    async listReviewFeedback() { return { items: [{ id: "unsafe-comment", kind: "comment", body: "Review", url: "javascript:alert(1)" }] }; },
    verifyAndNormalizeWebhook() { throw new Error("not used"); },
  };
  const input = { providerConfigId: "mock", repository: repo, title: "Change", generatedBody: "Generated evidence", headBranch: "feature", baseBranch: "main", changeSetId: fixture.changeSet.id };
  const actor = { username: "operator", isAdmin: true };
  const service = new DeliveryService(fixture.workspace, { providers: [config], pollIntervalSeconds: 60, requestTimeoutSeconds: 10 }, () => provider);
  const prepared = service.prepare({ ...input, expectedHeadSha: "fake", approvalId: "fake", revision: "fake" } as any, "stable-key", actor);
  assert.equal(prepared.request.expectedHeadSha, fixture.changeSet.headSha); assert.equal(prepared.request.revision, fixture.changeSet.captureIntegritySha256); assert.equal(prepared.request.patchContentSha256, fixture.changeSet.patchSha256); assert.equal(prepared.status, "awaiting_approval");
  assert.throws(() => service.approve(prepared.id, prepared.version, "fake-digest", actor), /digest/i);
  await assert.rejects(service.publishApproved(prepared.id, prepared.version, actor), /approval/i);
  const approved = service.approve(prepared.id, prepared.version, prepared.approvalDigest, actor); const first = await service.publishApproved(prepared.id, approved.version, actor); const replay = await service.publishApproved(prepared.id, approved.version, actor);
  assert.equal(first.id, replay.id); assert.equal(createCalls, 1);
  assert.throws(() => service.prepare({ ...input, generatedBody: "Changed fields" }, "stable-key", actor), /new key/i);
  assert.throws(() => service.prepare({ ...input, baseBranch: "release", existingDeliveryId: first.id }, "binding-key", actor), /existingDeliveryId/i);
  const updatePrepared = service.prepare({ ...input, generatedBody: "Changed fields", existingDeliveryId: first.id }, "changed-fields-key", actor); const updateApproved = service.approve(updatePrepared.id, updatePrepared.version, updatePrepared.approvalDigest, actor); await service.publishApproved(updatePrepared.id, updateApproved.version, actor); assert.equal(updateCalls, 1);
  const marked = mergeGeneratedBody("Human context", "Generated evidence", first.id).body; assert.throws(() => mergeGeneratedBody(marked.replace("Generated evidence", "Manual edit"), "Next", first.id), /edited remotely/);
  const safeRefresh = await service.refresh(first.id); assert.equal(safeRefresh.delivery.health, "online"); assert.equal(safeRefresh.delivery.checks[0]?.url, undefined); assert.equal(safeRefresh.delivery.feedback[0]?.url, undefined); assert.equal(safeRefresh.feedback[0]?.source.url, undefined);
  remote = { ...remote, url: "javascript:alert(1)" }; await assert.rejects(service.refresh(first.id), /unsafe|malformed/i); remote = { ...remote, url: "https://example.test/12" };
  fs.writeFileSync(path.join(fixture.workspace, ".history", "delivery-feedback.json"), "{corrupt", "utf8");
  await assert.rejects(service.refresh(first.id), /feedback persistence is invalid/i);
  fs.rmSync(path.join(fixture.workspace, ".history", "delivery-feedback.json"), { force: true });
  offline = true; const refreshed = await service.refresh(first.id); assert.equal(refreshed.delivery.stale, true); assert.equal(refreshed.delivery.remote.number, 12); assert.equal(refreshed.delivery.health, "offline");
});

test("ambiguous publication is never written twice and remains ambiguous until read-only reconcile finds an owned remote", async (t) => {
  const fixture = await createArtifactFixture(t); let createCalls = 0;
  const config: DeliveryProviderConfig = { id: "ambiguous", kind: "github", baseUrl: "https://api.example.test", tokenEnv: TOKEN_ENV };
  const repo: RepositoryRef = { providerConfigId: "ambiguous", remoteRepositoryId: "acme/repo", owner: "acme", name: "repo" };
  const provider: DeliveryProvider = { kind: "github", config, async probe() { throw new Error("unused"); }, async findChangeRequests() { return { items: [] }; }, async getChangeRequest() { throw new Error("unused"); }, async createChangeRequest() { createCalls += 1; throw new ProviderNetworkError("connection lost", true); }, async updateChangeRequest() { throw new Error("unused"); }, async listChecks() { return { items: [] }; }, async listReviewFeedback() { return { items: [] }; }, verifyAndNormalizeWebhook() { throw new Error("unused"); } };
  const service = new DeliveryService(fixture.workspace, { providers: [config], pollIntervalSeconds: 60, requestTimeoutSeconds: 10 }, () => provider); const actor = { username: "operator", isAdmin: true };
  const prepared = service.prepare({ providerConfigId: "ambiguous", repository: repo, title: "Change", generatedBody: "Evidence", headBranch: "feature", baseBranch: "main", changeSetId: fixture.changeSet.id }, "ambiguous-key", actor); const approved = service.approve(prepared.id, prepared.version, prepared.approvalDigest, actor);
  await assert.rejects(service.publishApproved(prepared.id, approved.version, actor), /reconcile/i); assert.equal(createCalls, 1);
  await assert.rejects(service.publishApproved(prepared.id, approved.version, actor), /reconcile/i); await assert.rejects(service.reconcileOperation(prepared.id), /remains ambiguous/i); assert.equal(createCalls, 1); assert.equal(service.getOperation(prepared.id).status, "ambiguous");
});
