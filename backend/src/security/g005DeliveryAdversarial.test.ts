import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { TaskManager } from "../agent/taskManager.js";
import { buildReviewArtifact, toSarifReviewArtifact } from "../artifacts/reviewArtifact.js";
import { createArtifactFixture } from "../chat/artifactTestSupport.js";
import { captureChangeSet } from "../chat/changeSets.js";
import { listChangeSetReviewRuns, scheduleChangeSetReview, setChangeSetReviewRunnerForTests } from "../chat/changeSetReviewRun.js";
import { ReviewFindingStore } from "../chat/reviewFindingStore.js";
import { createManagedWorktree } from "../chat/worktrees.js";
import { clearRegisteredDeliveryServicesForTests, DeliveryService, registerDeliveryService } from "../integrations/delivery/service.js";
import { ProviderNetworkError } from "../integrations/delivery/httpClient.js";
import type { DeliveryActor, DeliveryProvider, DeliveryProviderConfig, PrepareDeliveryInput, RemoteChangeRequest, RepositoryRef } from "../integrations/delivery/types.js";
import { DeliveryFeedbackStore } from "../integrations/feedbackStore.js";
import { deliveryWebhookRouter } from "../routes/delivery.js";

async function settleReview(workspace: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = listChangeSetReviewRuns(workspace).find((item) => item.id === runId);
    if (run?.status === "completed") return;
    if (run && ["failed", "interrupted"].includes(run.status)) throw new Error(run.error || `Review run ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Review run did not settle");
}

async function createBlockingFinding(t: test.TestContext) {
  const fixture = await createArtifactFixture(t);
  const reproduced = { severity: "error", path: "a.txt", line: 1, message: "Still reproducible after the proposed fix", evidence: ["targeted reproduction still fails"] };
  setChangeSetReviewRunnerForTests(async () => [reproduced]);
  const review = scheduleChangeSetReview(fixture.workspace, fixture.changeSet.id, "adversarial-review", "review");
  await settleReview(fixture.workspace, review.id);
  const store = new ReviewFindingStore(fixture.workspace);
  const open = store.list({ changeSetId: fixture.changeSet.id }).find((item) => item.message === reproduced.message);
  assert(open);
  return { fixture, store, finding: open, reproduced };
}

const deliveryActor: DeliveryActor = { username: "delivery-owner", isAdmin: true };

function deliveryInput(fixture: Awaited<ReturnType<typeof createArtifactFixture>>, overrides: Partial<PrepareDeliveryInput> = {}): PrepareDeliveryInput {
  const providerConfigId = overrides.providerConfigId || "adversarial-provider";
  return {
    providerConfigId,
    repository: { providerConfigId, remoteRepositoryId: "acme/repo", owner: "acme", name: "repo" },
    title: "Reviewed delivery",
    generatedBody: "Immutable review and evidence summary",
    headBranch: "crewforge/reviewed",
    baseBranch: "main",
    changeSetId: fixture.changeSet.id,
    ...overrides,
  };
}

function deliveryHarness(headSha: string, options: { ambiguousCreate?: boolean } = {}) {
  const config: DeliveryProviderConfig = { id: "adversarial-provider", kind: "github", baseUrl: "https://provider.invalid", tokenEnv: "UNUSED_ADVERSARIAL_TOKEN", webhookSecretEnv: "G005_ADVERSARIAL_WEBHOOK_SECRET" };
  let writes = 0;
  let creates = 0;
  let updates = 0;
  let remote: RemoteChangeRequest | undefined;
  const makeRemote = (body: string, title = "Reviewed delivery"): RemoteChangeRequest => ({
    providerConfigId: config.id,
    repositoryId: "acme/repo",
    number: 41,
    remoteId: "41",
    url: "https://provider.invalid/acme/repo/41",
    title,
    body,
    state: "open",
    headBranch: "crewforge/reviewed",
    baseBranch: "main",
    headSha,
    remoteVersion: "v1",
    mergeReadiness: "ready",
  });
  const provider: DeliveryProvider = {
    kind: "github",
    config,
    async probe() { throw new Error("not used"); },
    async findChangeRequests() { return { items: remote ? [structuredClone(remote)] : [] }; },
    async getChangeRequest() { if (!remote) throw new Error("remote missing"); return structuredClone(remote); },
    async createChangeRequest(request) {
      writes += 1; creates += 1; remote = makeRemote(request.body, request.title);
      if (options.ambiguousCreate) throw new ProviderNetworkError("connection lost after request bytes were sent", true);
      return structuredClone(remote);
    },
    async updateChangeRequest(_ref, patch) { writes += 1; updates += 1; remote = { ...(remote || makeRemote("")), title: patch.title || remote?.title || "Reviewed delivery", body: patch.body || remote?.body || "", remoteVersion: `v${updates + 1}` }; return structuredClone(remote); },
    async listChecks() { return { items: [] }; },
    async listReviewFeedback() { return { items: [] }; },
    verifyAndNormalizeWebhook() { throw new Error("not used"); },
  };
  const settings = { providers: [config], pollIntervalSeconds: 60, requestTimeoutSeconds: 10 };
  return { config, provider, settings, counts: () => ({ writes, creates, updates }), remote: () => remote };
}

async function approvedOperation(service: DeliveryService, input: PrepareDeliveryInput, key: string) {
  const prepared = service.prepare(input, key, deliveryActor);
  return service.approve(prepared.id, prepared.version, prepared.approvalDigest, deliveryActor);
}

test("a finding reproduced by independent reverify remains blocking and cannot become verified", async (t) => {
  const { fixture, store, finding, reproduced } = await createBlockingFinding(t);
  const fixedWorktree = createManagedWorktree(fixture.workspace, { name: "proposed-fix", ownerId: "writer", parentRunId: "parent-run-1", childRunId: "child-run-1", toolCallId: "parent-tool-1" });
  fs.writeFileSync(path.join(fixedWorktree.path, "a.txt"), "proposed fix that still reproduces\n");
  execFileSync("git", ["-C", fixedWorktree.path, "add", "a.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", fixedWorktree.path, "commit", "-m", "proposed fix"], { stdio: "ignore" });
  const fixedChangeSet = captureChangeSet(fixture.workspace, fixedWorktree.id, fixture.completionEvidence);
  setChangeSetReviewRunnerForTests(async () => []);
  const fixedReview = scheduleChangeSetReview(fixture.workspace, fixedChangeSet.id, "adversarial-fixed-review", "review");
  await settleReview(fixture.workspace, fixedReview.id);
  const accepted = store.transition(finding.id, "accepted", { id: "writer" }, { expectedVersion: finding.version });
  const fixed = store.transition(accepted.id, "fixed", { id: "writer" }, { expectedVersion: accepted.version, fixRef: fixedChangeSet.id });
  setChangeSetReviewRunnerForTests(async () => [reproduced]);
  const reverify = scheduleChangeSetReview(fixture.workspace, fixedChangeSet.id, "adversarial-reverify", "reverify");
  await settleReview(fixture.workspace, reverify.id);
  const after = store.list().find((item) => item.id === fixed.id);
  assert(after);
  assert.equal(after.lifecycle, "open");
  const completedReverify = listChangeSetReviewRuns(fixture.workspace, fixedChangeSet.id).find((item) => item.id === reverify.id);
  assert(completedReverify?.verificationResults?.some((item) => item.findingId === finding.id && item.status === "reproduced"));
  assert.equal(buildReviewArtifact(fixture.workspace, fixedChangeSet.id).gate.decision, "blocked");
});

test("fake approval and missing immutable bindings are rejected before any provider write", async (t) => {
  const fixture = await createArtifactFixture(t);
  const harness = deliveryHarness(fixture.changeSet.headSha);
  const service = new DeliveryService(fixture.workspace, harness.settings, () => harness.provider);
  const input = deliveryInput(fixture);
  const prepared = service.prepare(input, "fake-approval", deliveryActor);
  assert.throws(() => service.approve(prepared.id, prepared.version, "0".repeat(64), deliveryActor), /approval|digest/i);
  await assert.rejects(service.publishApproved(prepared.id, prepared.version, deliveryActor), /approval/i);
  assert.throws(() => service.prepare({ ...input, changeSetId: "0".repeat(64) }, "missing-binding", deliveryActor), /change set|not found/i);
  assert.equal(harness.counts().writes, 0);
});

test("an ambiguous provider write can only reconcile read-only and is never sent twice", async (t) => {
  const fixture = await createArtifactFixture(t);
  const harness = deliveryHarness(fixture.changeSet.headSha, { ambiguousCreate: true });
  const service = new DeliveryService(fixture.workspace, harness.settings, () => harness.provider);
  const approved = await approvedOperation(service, deliveryInput(fixture), "ambiguous-once");
  await assert.rejects(service.publishApproved(approved.id, approved.version, deliveryActor), /ambiguous|reconcile/i);
  const ambiguous = service.getOperation(approved.id);
  assert.equal(ambiguous.status, "ambiguous");
  await assert.rejects(service.publishApproved(ambiguous.id, ambiguous.version, deliveryActor), /ambiguous|reconcile/i);
  const reconciled = await service.reconcileOperation(ambiguous.id);
  assert.equal(reconciled.remote.number, 41);
  assert.equal(harness.counts().writes, 1);
  assert.equal(service.getOperation(ambiguous.id).status, "succeeded");
});

test("physical deletion cannot remove an unresolved review blocker from the immutable gate", async (t) => {
  const { fixture, store, finding } = await createBlockingFinding(t);
  try { store.delete(finding.id); } catch { /* refusing deletion is valid */ }
  const persisted = store.list({ changeSetId: fixture.changeSet.id }).find((item) => item.id === finding.id);
  assert(persisted, "the unresolved blocker must remain durably represented");
  const artifact = buildReviewArtifact(fixture.workspace, fixture.changeSet.id);
  assert.equal(artifact.gate.decision, "blocked");
  assert(artifact.gate.blockers.some((item) => item.findingId === finding.id));
});

test("two workspaces sharing a provider route a webhook only to the exact binding and use polling for an unbound event", async (t) => {
  const previousSecret = process.env.G005_ADVERSARIAL_WEBHOOK_SECRET;
  process.env.G005_ADVERSARIAL_WEBHOOK_SECRET = "adversarial-webhook-secret";
  t.after(() => { if (previousSecret === undefined) delete process.env.G005_ADVERSARIAL_WEBHOOK_SECRET; else process.env.G005_ADVERSARIAL_WEBHOOK_SECRET = previousSecret; });
  clearRegisteredDeliveryServicesForTests();
  t.after(() => clearRegisteredDeliveryServicesForTests());
  const firstFixture = await createArtifactFixture(t, { patchContent: "workspace one\n" });
  const secondFixture = await createArtifactFixture(t, { patchContent: "workspace two\n" });
  const firstHarness = deliveryHarness(firstFixture.changeSet.headSha);
  const secondHarness = deliveryHarness(secondFixture.changeSet.headSha);
  const settings = firstHarness.settings;
  let event = {
    providerConfigId: firstHarness.config.id,
    deliveryId: "webhook-exact-1",
    event: "pull_request_review_comment",
    repositoryId: "acme/two",
    changeRequestNumber: 41,
    headSha: secondFixture.changeSet.headSha,
    feedback: { id: "workspace-two-comment", kind: "inline_comment" as const, body: "Only workspace two owns this", path: "a.txt", line: 1 },
    receivedAt: Date.now(),
  };
  firstHarness.provider.verifyAndNormalizeWebhook = () => structuredClone(event);
  secondHarness.provider.verifyAndNormalizeWebhook = () => structuredClone(event);
  let firstPolls = 0;
  let secondPolls = 0;
  const firstGet = firstHarness.provider.getChangeRequest.bind(firstHarness.provider);
  const secondGet = secondHarness.provider.getChangeRequest.bind(secondHarness.provider);
  firstHarness.provider.getChangeRequest = async (...args) => { firstPolls += 1; return firstGet(...args); };
  secondHarness.provider.getChangeRequest = async (...args) => { secondPolls += 1; return secondGet(...args); };
  const first = registerDeliveryService(firstFixture.workspace, settings, () => firstHarness.provider);
  const second = registerDeliveryService(secondFixture.workspace, settings, () => secondHarness.provider);
  const firstApproved = await approvedOperation(first, deliveryInput(firstFixture, { repository: { providerConfigId: firstHarness.config.id, remoteRepositoryId: "acme/one", owner: "acme", name: "one" } }), "workspace-one");
  await first.publishApproved(firstApproved.id, firstApproved.version, deliveryActor);
  const secondApproved = await approvedOperation(second, deliveryInput(secondFixture, { repository: { providerConfigId: secondHarness.config.id, remoteRepositoryId: "acme/two", owner: "acme", name: "two" } }), "workspace-two");
  await second.publishApproved(secondApproved.id, secondApproved.version, deliveryActor);

  const app = express();
  app.use(deliveryWebhookRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/${firstHarness.config.id}`;
  const exact = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(exact.status, 202);
  const exactBody = await exact.json() as { accepted: boolean; pollFallback?: boolean };
  assert.equal(exactBody.accepted, true);
  assert.equal(first.listFeedback().length, 0);
  assert.equal(second.listFeedback().length, 1);

  event = { ...event, deliveryId: "webhook-unbound-2", repositoryId: "acme/unbound", headSha: "f".repeat(40), feedback: { ...event.feedback, id: "unbound-comment" } };
  const unbound = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unbound.status, 202);
  assert.deepEqual(await unbound.json(), {
    accepted: false,
    pollFallback: true,
    retryable: false,
    services: { total: 2, verified: 2, verificationFailed: 0, consumed: 0, duplicates: 0, pollSucceeded: 2, pollFailed: 0, internalFailed: 0 },
  });
  for (let attempt = 0; attempt < 100 && (firstPolls === 0 || secondPolls === 0); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(firstPolls > 0);
  assert(secondPolls > 0);
  assert.equal(first.listFeedback().length, 0);
  assert.equal(second.listFeedback().length, 1);
});

test("existingDeliveryId cannot cross immutable provider/repository bindings", async (t) => {
  const fixture = await createArtifactFixture(t);
  const harness = deliveryHarness(fixture.changeSet.headSha);
  const service = new DeliveryService(fixture.workspace, harness.settings, () => harness.provider);
  const firstApproved = await approvedOperation(service, deliveryInput(fixture), "binding-first");
  const binding = await service.publishApproved(firstApproved.id, firstApproved.version, deliveryActor);
  const writesBefore = harness.counts().writes;
  const crossed: RepositoryRef = { providerConfigId: harness.config.id, remoteRepositoryId: "other/repository", owner: "other", name: "repository" };
  assert.throws(() => service.prepare(deliveryInput(fixture, { existingDeliveryId: binding.id, repository: crossed }), "binding-cross", deliveryActor), /binding|match|repository/i);
  assert.equal(harness.counts().writes, writesBefore);
});

test("changed generated body with a different idempotency key performs one bound update", async (t) => {
  const fixture = await createArtifactFixture(t);
  const harness = deliveryHarness(fixture.changeSet.headSha);
  const service = new DeliveryService(fixture.workspace, harness.settings, () => harness.provider);
  const firstApproved = await approvedOperation(service, deliveryInput(fixture, { generatedBody: "Evidence body one" }), "body-one");
  const first = await service.publishApproved(firstApproved.id, firstApproved.version, deliveryActor);
  const secondApproved = await approvedOperation(service, deliveryInput(fixture, { existingDeliveryId: first.id, generatedBody: "Evidence body two" }), "body-two");
  const second = await service.publishApproved(secondApproved.id, secondApproved.version, deliveryActor);
  assert.equal(second.id, first.id);
  assert.equal(harness.counts().creates, 1);
  assert.equal(harness.counts().updates, 1);
  assert.equal(harness.counts().writes, 2);
  assert.match(second.remote.body, /Evidence body two/);
  assert.doesNotMatch(second.remote.body, /Evidence body one/);
});

test("approved provider feedback creates one gated task and accepts only the exact originating run lineage", async (t) => {
  const fixture = await createArtifactFixture(t);
  const harness = deliveryHarness(fixture.changeSet.headSha);
  const service = new DeliveryService(fixture.workspace, harness.settings, () => harness.provider);
  const approved = await approvedOperation(service, deliveryInput(fixture), "feedback-binding");
  const binding = await service.publishApproved(approved.id, approved.version, deliveryActor);
  const webhook = service.consumeVerifiedWebhook({
    providerConfigId: harness.config.id,
    deliveryId: "provider-delivery-feedback-1",
    event: "pull_request_review_comment",
    repositoryId: binding.repositoryId,
    changeRequestNumber: binding.remote.number,
    headSha: binding.headSha,
    feedback: { id: "comment-1", kind: "inline_comment", author: "reviewer", body: "Please fix the exact reviewed line", path: "a.txt", line: 1, headSha: binding.headSha },
    receivedAt: Date.now(),
  });
  assert.equal(webhook.consumed, true);
  assert(webhook.feedback);
  const taskCreated = service.approveFeedback(binding.id, webhook.feedback.id, "human-approval", webhook.feedback.version);
  assert.equal(taskCreated.lifecycle, "task_created");
  const tasks = new TaskManager(fixture.workspace).listTasks();
  assert.equal(tasks.length, 1);
  const description = JSON.parse(tasks[0].description) as Record<string, unknown>;
  assert.equal(description.feedbackId, webhook.feedback.id);
  assert.equal(description.changeSetId, binding.changeSetId);
  assert.equal(description.revision, binding.revision);
  assert.equal(description.conversationId, binding.conversationId);
  assert.equal(description.executionPlanId, binding.executionPlanId);
  assert.equal(description.parentRunId, binding.originRunId);
  const feedbackStore = new DeliveryFeedbackStore(fixture.workspace);
  assert.throws(() => feedbackStore.attachFollowUpRun(taskCreated.id, "follow-up-run", "wrong-origin", "human", taskCreated.version), /lineage/i);
  const attached = feedbackStore.attachFollowUpRun(taskCreated.id, "follow-up-run", binding.originRunId, "human", taskCreated.version);
  assert.equal(attached.followUpRunId, "follow-up-run");
  assert.equal(attached.originRunId, binding.originRunId);
  assert.equal(attached.changeSetId, binding.changeSetId);
  assert.equal(attached.revision, binding.revision);
});

test("SARIF export satisfies the real result/rule/location schema instead of only carrying CrewForge properties", async (t) => {
  const { fixture } = await createBlockingFinding(t);
  const sarif = toSarifReviewArtifact(buildReviewArtifact(fixture.workspace, fixture.changeSet.id));
  assert.equal(sarif.version, "2.1.0");
  assert.match(sarif.$schema, /^https:\/\/.*sarif.*\.json$/i);
  assert.equal(Array.isArray(sarif.runs), true);
  const run = sarif.runs[0] as any;
  assert.equal(typeof run?.tool?.driver?.name, "string");
  assert(run.tool.driver.name.length > 0);
  assert(Array.isArray(run.tool.driver.rules));
  assert(Array.isArray(run.results));
  assert(run.results.length > 0);
  for (const result of run.results) {
    assert.equal(typeof result.ruleId, "string");
    assert(Number.isSafeInteger(result.ruleIndex));
    assert.equal(run.tool.driver.rules[result.ruleIndex]?.id, result.ruleId);
    assert.equal(typeof result.message?.text, "string");
    assert(result.message.text.length > 0);
    const physical = result.locations?.[0]?.physicalLocation;
    assert.equal(typeof physical?.artifactLocation?.uri, "string");
    assert(physical.artifactLocation.uri.length > 0);
    assert(Number.isSafeInteger(physical?.region?.startLine) && physical.region.startLine >= 1);
    assert(Object.values(result.fingerprints || {}).every((value) => typeof value === "string" && value.length > 0));
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(sarif)));
});
