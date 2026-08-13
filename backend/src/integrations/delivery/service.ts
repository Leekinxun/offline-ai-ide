import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { buildReviewArtifact } from "../../artifacts/reviewArtifact.js";
import { changeSetReviewRevision, getChangeSet } from "../../chat/changeSets.js";
import { readExecutionPlan } from "../../chat/executionPlans.js";
import { readRunRecord } from "../../chat/runHistory.js";
import { DeliveryFeedbackStore } from "../feedbackStore.js";
import type { DeliveryFeedbackV1, NormalizedDeliveryEventV1 } from "../types.js";
import { ProviderHttpClient, ProviderHttpError, ProviderNetworkError } from "./httpClient.js";
import { DeliveryStore, type DeliveryOperation } from "./store.js";
import type { ChangeRequestRef, DeliveryActor, DeliveryBinding, DeliveryProvider, DeliveryProviderConfig, DeliveryRuntimeSettings, NormalizedCheck, NormalizedReviewFeedback, PrepareDeliveryInput, PreparedDeliveryRequest, ProviderCapabilities, RemoteChangeRequest, RepositoryRef, VerifiedDeliveryEvent, WriteOperationContext } from "./types.js";
import { DeliveryConflictError, DeliveryUnavailableError } from "./types.js";
import { GithubDeliveryProvider } from "./providers/github.js";
import { GitlabDeliveryProvider } from "./providers/gitlab.js";
import { GiteaDeliveryProvider } from "./providers/gitea.js";

const START = "<!-- crownforge:generated:start";
const END = "<!-- crownforge:generated:end -->";
const MAX_PAGES = 10;
function sha256(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string { const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize) : input && typeof input === "object" ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : input; return JSON.stringify(normalize(value)); }
function deliveryId(request: PreparedDeliveryRequest): string { return `delivery-${sha256([request.providerConfigId, request.repository.remoteRepositoryId, request.headBranch, request.baseBranch, request.changeSetId, request.revision].join("\0")).slice(0, 32)}`; }
function marker(id: string, body: string): { rendered: string; digest: string } { const digest = sha256(body); return { digest, rendered: `${START} delivery=${id} digest=${digest} -->\n${body}\n${END}` }; }
function ownsGeneratedBlock(body: string, id: string): boolean { return body.includes(`${START} delivery=${id} digest=`); }
export function mergeGeneratedBody(existingBody: string, generatedBody: string, id: string): { body: string; digest: string } {
  const next = marker(id, generatedBody); const start = `${START} delivery=${id} digest=`; const index = existingBody.indexOf(start);
  if (index < 0) return { body: `${existingBody.trim()}${existingBody.trim() ? "\n\n" : ""}${next.rendered}`, digest: next.digest };
  const headerEnd = existingBody.indexOf(" -->", index); const blockEnd = existingBody.indexOf(END, headerEnd + 4);
  if (headerEnd < 0 || blockEnd < 0) throw new DeliveryConflictError("generated_body_conflict", "Generated delivery block is malformed");
  const declared = existingBody.slice(index + start.length, headerEnd).trim(); const contentStart = headerEnd + 4 + (existingBody[headerEnd + 4] === "\n" ? 1 : 0); const content = existingBody.slice(contentStart, blockEnd).replace(/\n$/, "");
  if (sha256(content) !== declared) throw new DeliveryConflictError("generated_body_conflict", "Generated delivery block was edited remotely");
  return { body: `${existingBody.slice(0, index)}${next.rendered}${existingBody.slice(blockEnd + END.length)}`, digest: next.digest };
}

function createProvider(config: DeliveryProviderConfig, settings: DeliveryRuntimeSettings): DeliveryProvider {
  const options = { timeoutMs: settings.requestTimeoutSeconds * 1_000 };
  if (config.kind === "github") return new GithubDeliveryProvider(config, new ProviderHttpClient(config.baseUrl, options));
  if (config.kind === "gitlab") return new GitlabDeliveryProvider(config, new ProviderHttpClient(/\/api\/v4\/?$/.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl.replace(/\/$/, "")}/api/v4`, options));
  return new GiteaDeliveryProvider(config, new ProviderHttpClient(/\/api\/v1\/?$/.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl.replace(/\/$/, "")}/api/v1`, options));
}
function text(value: unknown, field: string, max: number): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim().slice(0, max); }
function normalizeRepository(input: RepositoryRef, providerConfigId: string): RepositoryRef {
  if (!input || input.providerConfigId !== providerConfigId) throw new Error("Repository/provider mismatch");
  return { providerConfigId, remoteRepositoryId: text(input.remoteRepositoryId, "remoteRepositoryId", 500), ...(typeof input.owner === "string" && input.owner.trim() ? { owner: input.owner.trim().slice(0, 200) } : {}), ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim().slice(0, 200) } : {}), ...(typeof input.gitRemoteName === "string" && input.gitRemoteName.trim() ? { gitRemoteName: input.gitRemoteName.trim().slice(0, 100) } : {}) };
}

function isProviderAvailabilityError(error: unknown): boolean {
  return error instanceof ProviderNetworkError || error instanceof ProviderHttpError || error instanceof DeliveryUnavailableError;
}

export interface DeliveryPollingStatus {
  state: "idle" | "running" | "succeeded" | "failed";
  attempt: number;
  retryable: boolean;
}

export class DeliveryService {
  private readonly store: DeliveryStore;
  private readonly feedback: DeliveryFeedbackStore;
  private readonly providers = new Map<string, DeliveryProvider>();
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private scheduledPoll?: Promise<void>;
  private pollingStatus: DeliveryPollingStatus = { state: "idle", attempt: 0, retryable: false };
  constructor(readonly workspace: string, readonly settings: DeliveryRuntimeSettings, providerFactory: (config: DeliveryProviderConfig, settings: DeliveryRuntimeSettings) => DeliveryProvider = createProvider) {
    this.store = new DeliveryStore(workspace); this.feedback = new DeliveryFeedbackStore(workspace);
    for (const config of settings.providers) if (!config.disabled) this.providers.set(config.id, providerFactory(config, settings));
  }
  private provider(id: string): DeliveryProvider { const provider = this.providers.get(id); if (!provider) throw new Error(`Delivery provider is disabled or missing: ${id}`); return provider; }
  getBinding(id: string): DeliveryBinding | undefined { return this.store.getDelivery(id); }
  listBindings(): DeliveryBinding[] { return this.store.listDeliveries(); }
  getOperation(id: string): DeliveryOperation { return this.store.getOperation(id); }
  listOperations(): DeliveryOperation[] { return this.store.listOperations(); }
  listFeedback(id?: string): DeliveryFeedbackV1[] { const items = this.feedback.list(); return id ? items.filter((item) => item.deliveryId === id || this.store.getDelivery(id)?.proposalKey === item.proposalKey) : items; }
  approveFeedback(delivery: string, id: string, actorId: string, expectedVersion: number): DeliveryFeedbackV1 { const binding = this.store.getDelivery(delivery); const item = this.feedback.get(id); if (!binding || (item.deliveryId !== delivery && item.proposalKey !== binding.proposalKey)) throw new Error("Delivery feedback does not belong to this delivery"); return this.feedback.approveAndCreateTask(id, actorId, expectedVersion); }

  private resolvePrepared(input: PrepareDeliveryInput): PreparedDeliveryRequest {
    const providerConfigId = text(input?.providerConfigId, "providerConfigId", 160); this.provider(providerConfigId);
    const repository = normalizeRepository(input.repository, providerConfigId); const changeSetId = text(input.changeSetId, "changeSetId", 160); let changeSet: ReturnType<typeof getChangeSet>;
    try { changeSet = getChangeSet(this.workspace, changeSetId); } catch { throw new Error("Change set not found or invalid"); }
    if (changeSet.status !== "ready_for_review") throw new DeliveryConflictError("approval_conflict", "ChangeSet is not ready for remote publication");
    if (!changeSet.childRunId) throw new DeliveryConflictError("approval_conflict", "ChangeSet is missing its originating run");
    const run = readRunRecord(this.workspace, changeSet.childRunId);
    if (run.status !== "completed" || run.completionEvidence?.outcome !== "completed") throw new DeliveryConflictError("approval_conflict", "Originating run has not completed with valid evidence");
    const ledger = run.completionEvidence.ledger;
    if (ledger.blockers.length || ledger.verification.some((item) => item.status !== "passed") || ledger.criteria.some((item) => item.state !== "passed")) throw new DeliveryConflictError("approval_conflict", "Completion evidence ledger has unmet gates");
    if (run.executionPlanId) readExecutionPlan(this.workspace, run.executionPlanId);
    const revision = changeSetReviewRevision(changeSet); const artifact = buildReviewArtifact(this.workspace, changeSet.id, revision);
    if (artifact.gate.decision !== "ready" || !artifact.reviewRuns.some((review) => review.status === "completed")) throw new DeliveryConflictError("approval_conflict", "Completed independent review is required for the exact ChangeSet revision");
    const request: PreparedDeliveryRequest = {
      providerConfigId, repository, title: text(input.title, "title", 500), generatedBody: text(input.generatedBody, "generatedBody", 100_000), headBranch: text(input.headBranch, "headBranch", 500), baseBranch: text(input.baseBranch, "baseBranch", 500), changeSetId: changeSet.id,
      ...(input.draft === true ? { draft: true } : {}), ...(typeof input.existingDeliveryId === "string" && input.existingDeliveryId.trim() ? { existingDeliveryId: input.existingDeliveryId.trim().slice(0, 200) } : {}),
      expectedHeadSha: changeSet.headSha, conversationId: run.conversationId, ...(run.executionPlanId ? { executionPlanId: run.executionPlanId } : {}), originRunId: run.runId, ...(changeSet.parentRunId || run.parentRunId ? { parentRunId: changeSet.parentRunId || run.parentRunId } : {}), worktreeId: changeSet.worktreeId, revision, patchContentSha256: changeSet.patchSha256, evidenceLedgerDigest: sha256(canonical(ledger)), reviewArtifactDigest: artifact.artifactDigest,
    };
    if (request.existingDeliveryId) { const binding = this.store.getDelivery(request.existingDeliveryId); this.assertBindingExact(binding, request); if (binding.remote.remoteVersion) request.expectedRemoteVersion = binding.remote.remoteVersion; }
    return request;
  }

  private assertBindingExact(binding: DeliveryBinding | undefined, request: PreparedDeliveryRequest): asserts binding is DeliveryBinding {
    const exact = binding && binding.providerConfigId === request.providerConfigId && binding.repositoryId === request.repository.remoteRepositoryId && binding.headSha === request.expectedHeadSha && binding.remote.headBranch === request.headBranch && binding.remote.baseBranch === request.baseBranch && binding.changeSetId === request.changeSetId && binding.revision === request.revision && binding.patchContentSha256 === request.patchContentSha256 && binding.conversationId === request.conversationId && binding.executionPlanId === request.executionPlanId && binding.originRunId === request.originRunId && binding.parentRunId === request.parentRunId && binding.worktreeId === request.worktreeId && binding.evidenceLedgerDigest === request.evidenceLedgerDigest;
    if (!exact) throw new DeliveryConflictError("binding_conflict", "existingDeliveryId does not match the exact provider, repository, branches, ChangeSet revision, lineage, and evidence binding");
  }

  prepare(input: PrepareDeliveryInput, idempotencyKey: string, actor: DeliveryActor): DeliveryOperation {
    if (!actor.username.trim()) throw new Error("Authenticated actor is required"); const request = this.resolvePrepared(input); const requestDigest = sha256(canonical(request));
    const approvalDigest = sha256(canonical({ kind: "crewforge.delivery.approval", requestDigest, actor: actor.username, reviewArtifactDigest: request.reviewArtifactDigest, evidenceLedgerDigest: request.evidenceLedgerDigest }));
    return this.store.prepare({ idempotencyKey, requestDigest, approvalDigest, providerConfigId: request.providerConfigId, actorId: actor.username, request });
  }
  approve(id: string, expectedVersion: number, approvalDigest: string, actor: DeliveryActor): DeliveryOperation { return this.store.approve(id, expectedVersion, approvalDigest, actor.username); }

  private operationContext(operation: DeliveryOperation): WriteOperationContext { const request = operation.request; return { idempotencyKey: operation.idempotencyKeyHash, requestDigest: operation.requestDigest, approvalId: operation.approval!.digest, conversationId: request.conversationId, planId: request.executionPlanId, runId: request.originRunId, parentRunId: request.parentRunId, worktreeId: request.worktreeId, changeSetId: request.changeSetId, revision: request.revision, patchContentSha256: request.patchContentSha256, evidenceLedgerDigest: request.evidenceLedgerDigest }; }
  private validateOperationArtifacts(operation: DeliveryOperation): PreparedDeliveryRequest { const current = this.resolvePrepared(operation.request); if (canonical(current) !== canonical(operation.request)) throw new DeliveryConflictError("stale_head", "Server-owned ChangeSet, lineage, review, or evidence binding changed after approval"); return current; }
  private async findOwnedTarget(provider: DeliveryProvider, request: PreparedDeliveryRequest, id: string, signal?: AbortSignal): Promise<RemoteChangeRequest | undefined> {
    const candidates = await this.collectPages<RemoteChangeRequest>((cursor) => provider.findChangeRequests(request.repository, { head: request.headBranch, base: request.baseBranch }, cursor, signal));
    const owned = candidates.find((item) => ownsGeneratedBlock(item.body, id)); if (owned) return owned;
    if (candidates.length) throw new DeliveryConflictError("provider_conflict", "A remote change request already uses these branches but is not owned by this delivery operation");
    return undefined;
  }
  private finalize(operation: DeliveryOperation, remote: RemoteChangeRequest): DeliveryBinding {
    const request = operation.request; if (remote.headSha && remote.headSha !== request.expectedHeadSha) throw new DeliveryConflictError("upstream_changed", `Expected published head ${request.expectedHeadSha}, got ${remote.headSha}`);
    const id = deliveryId(request); const now = Date.now(); const existing = this.store.getDelivery(id); const generated = marker(id, request.generatedBody);
    const binding: DeliveryBinding = { schemaVersion: 1, id, providerConfigId: request.providerConfigId, repositoryId: request.repository.remoteRepositoryId, proposalKey: String(remote.number), headSha: remote.headSha || request.expectedHeadSha, conversationId: request.conversationId, ...(request.executionPlanId ? { executionPlanId: request.executionPlanId } : {}), originRunId: request.originRunId, ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}), worktreeId: request.worktreeId, changeSetId: request.changeSetId, revision: request.revision, patchContentSha256: request.patchContentSha256, createdAt: existing?.createdAt || now, updatedAt: now, repository: request.repository, remote, evidenceLedgerDigest: request.evidenceLedgerDigest, generatedBodyDigest: generated.digest, lastSyncedAt: now, stale: false, health: "online", checks: existing?.checks || [], feedback: existing?.feedback || [] };
    const persisted = this.store.putDelivery(binding); this.store.finish(operation.id, "succeeded", { deliveryId: persisted.id }); return persisted;
  }

  async publishApproved(id: string, expectedVersion: number, actor: DeliveryActor, signal?: AbortSignal): Promise<DeliveryBinding> {
    const prior = this.store.getOperation(id); if (prior.status === "succeeded" && prior.deliveryId) { const binding = this.store.getDelivery(prior.deliveryId); if (binding) return binding; }
    const operation = this.store.claimApproved(id, expectedVersion, actor.username); let request: PreparedDeliveryRequest;
    try { request = this.validateOperationArtifacts(operation); } catch (error) { this.store.finish(operation.id, "failed", { error: error instanceof Error ? error.message : String(error) }); throw error; }
    const provider = this.provider(request.providerConfigId); const targetId = deliveryId(request); const existingBinding = request.existingDeliveryId ? this.store.getDelivery(request.existingDeliveryId) : undefined; if (request.existingDeliveryId) this.assertBindingExact(existingBinding, request);
    try {
      let target = existingBinding?.remote || await this.findOwnedTarget(provider, request, targetId, signal); let remote: RemoteChangeRequest;
      if (target) {
        const body = mergeGeneratedBody(target.body, request.generatedBody, targetId); const ref: ChangeRequestRef = { ...request.repository, number: target.number };
        remote = await provider.updateChangeRequest(ref, { title: request.title, body: body.body, baseBranch: request.baseBranch }, { expectedHeadSha: request.expectedHeadSha, expectedRemoteVersion: request.expectedRemoteVersion || target.remoteVersion }, this.operationContext(operation), signal);
      } else {
        const body = marker(targetId, request.generatedBody).rendered; remote = await provider.createChangeRequest({ repository: request.repository, title: request.title, body, headBranch: request.headBranch, baseBranch: request.baseBranch, draft: request.draft }, this.operationContext(operation), signal);
      }
      return this.finalize(operation, remote);
    } catch (error) {
      if (error instanceof ProviderNetworkError && error.requestMayHaveBeenSent) { this.store.finish(operation.id, "ambiguous", { error: error.message }); throw new DeliveryConflictError("ambiguous_operation", "Provider may have accepted the write; only read-only reconcile is allowed"); }
      this.store.finish(operation.id, "failed", { error: error instanceof Error ? error.message : String(error) }); throw error;
    }
  }

  async reconcileOperation(id: string, signal?: AbortSignal): Promise<DeliveryBinding> {
    const operation = this.store.getOperation(id); if (operation.status === "succeeded" && operation.deliveryId) { const binding = this.store.getDelivery(operation.deliveryId); if (binding) return binding; }
    if (operation.status !== "ambiguous") throw new DeliveryConflictError("ambiguous_operation", "Only an ambiguous publication can be reconciled"); const request = this.validateOperationArtifacts(operation); const provider = this.provider(request.providerConfigId); const remote = await this.findOwnedTarget(provider, request, deliveryId(request), signal);
    if (!remote) throw new DeliveryConflictError("ambiguous_operation", "Read-only reconcile found no owned remote change request; operation remains ambiguous"); return this.finalize(operation, remote);
  }

  async capabilities(repository: RepositoryRef, providerConfigId?: string, signal?: AbortSignal): Promise<ProviderCapabilities[]> { const entries = providerConfigId ? [[providerConfigId, this.provider(providerConfigId)] as const] : [...this.providers.entries()]; const result: ProviderCapabilities[] = []; for (const [, provider] of entries) { const item = await provider.probe(repository, signal); this.store.putCapabilities(item); result.push(item); } return result; }
  async refresh(id: string, signal?: AbortSignal): Promise<{ delivery: DeliveryBinding; feedback: DeliveryFeedbackV1[] }> {
    const binding = this.store.getDelivery(id); if (!binding) throw new Error("Delivery binding not found"); const provider = this.provider(binding.providerConfigId);
    let remote: RemoteChangeRequest; let checks: NormalizedCheck[]; let comments: NormalizedReviewFeedback[];
    try {
      remote = await provider.getChangeRequest({ ...binding.repository, number: binding.remote.number }, signal);
      checks = await this.collectPages<NormalizedCheck>((cursor) => provider.listChecks(binding.repository, remote.headSha || binding.headSha, cursor, signal));
      comments = await this.collectPages<NormalizedReviewFeedback>((cursor) => provider.listReviewFeedback({ ...binding.repository, number: remote.number }, cursor, signal));
    } catch (error) {
      if (!isProviderAvailabilityError(error)) throw error;
      const next = this.store.putDelivery({ ...binding, stale: true, health: "offline", updatedAt: Date.now() });
      return { delivery: next, feedback: this.listFeedback(id) };
    }
    const now = Date.now();
    const next = this.store.putDelivery({ ...binding, remote, headSha: remote.headSha || binding.headSha, checks, feedback: comments, updatedAt: now, lastSyncedAt: now, stale: false, health: "online" });
    return { delivery: next, feedback: this.ingestPollFeedback(next, next.checks, next.feedback) };
  }
  private async collectPages<T>(load: (cursor?: { value?: string }) => Promise<{ items: T[]; nextCursor?: { value?: string } }>): Promise<T[]> { const result: T[] = []; let cursor: { value?: string } | undefined; for (let page = 0; page < MAX_PAGES; page += 1) { const value = await load(cursor); result.push(...value.items); if (!value.nextCursor?.value) return result; cursor = value.nextCursor; } return result; }
  private ingestPollFeedback(binding: DeliveryBinding, checks: NormalizedCheck[], comments: NormalizedReviewFeedback[]): DeliveryFeedbackV1[] { const result: DeliveryFeedbackV1[] = []; for (const check of checks.filter((item) => item.state === "failure")) result.push(this.feedback.ingest(this.event(binding, `poll:${check.id}:${check.completedAt || binding.headSha}`, { kind: "ci_check", id: check.id, name: check.name, conclusion: check.state, url: check.url, evidence: [check.description || "CI check failed"] }), binding)); for (const comment of comments.filter((item) => item.kind === "comment" || item.kind === "inline_comment" || item.state === "changes_requested")) result.push(this.feedback.ingest(this.event(binding, `poll:${comment.id}:${comment.updatedAt || binding.headSha}`, { kind: "review_comment", id: comment.id, author: comment.author, body: comment.body, url: comment.url, path: comment.path, line: comment.line }), binding)); return result; }
  private event(binding: DeliveryBinding, id: string, source: NormalizedDeliveryEventV1["source"]): NormalizedDeliveryEventV1 { return { schemaVersion: 1, providerConfigId: binding.providerConfigId, deliveryId: id, repositoryId: binding.repositoryId, proposalKey: binding.proposalKey, headSha: binding.headSha, receivedAt: Date.now(), source }; }

  verifyWebhook(providerConfigId: string, rawBody: Buffer, headers: IncomingHttpHeaders): VerifiedDeliveryEvent { const provider = this.provider(providerConfigId); const secretEnv = provider.config.webhookSecretEnv; const secret = secretEnv ? process.env[secretEnv] : undefined; if (!secret) throw new Error("Webhook secret environment variable is not configured"); return provider.verifyAndNormalizeWebhook(rawBody, headers, secret); }
  consumeVerifiedWebhook(event: VerifiedDeliveryEvent): { consumed: boolean; duplicate: boolean; event: VerifiedDeliveryEvent; feedback?: DeliveryFeedbackV1 } {
    const binding = this.store.listDeliveries().find((item) => item.providerConfigId === event.providerConfigId && item.repositoryId === event.repositoryId && event.changeRequestNumber === item.remote.number && event.headSha === item.headSha);
    if (!binding) return { consumed: false, duplicate: false, event }; if (!this.store.recordWebhook(event)) return { consumed: true, duplicate: true, event }; if (!event.check && !event.feedback) return { consumed: true, duplicate: false, event };
    const source: NormalizedDeliveryEventV1["source"] = event.check ? { kind: "ci_check", id: event.check.id, name: event.check.name, conclusion: event.check.state, url: event.check.url, evidence: [event.check.description || event.event] } : { kind: "review_comment", id: event.feedback!.id, author: event.feedback!.author, body: event.feedback!.body, url: event.feedback!.url, path: event.feedback!.path, line: event.feedback!.line };
    const normalized = this.event(binding, event.deliveryId, source); event.normalizedFeedback = normalized; return { consumed: true, duplicate: false, event, feedback: this.feedback.ingest(normalized, binding) };
  }
  async pollAll(signal?: AbortSignal): Promise<void> { if (this.polling) return; this.polling = true; try { for (const binding of this.store.listDeliveries()) { if (signal?.aborted) return; await this.refresh(binding.id, signal); } } finally { this.polling = false; } }
  getPollingStatus(): DeliveryPollingStatus { return { ...this.pollingStatus }; }
  private runScheduledPoll(): void {
    if (this.scheduledPoll) return;
    this.pollingStatus = { state: "running", attempt: this.pollingStatus.attempt + 1, retryable: false };
    const tracked = Promise.resolve().then(() => this.pollAll()).then(
      () => { this.pollingStatus = { state: "succeeded", attempt: this.pollingStatus.attempt, retryable: false }; },
      () => { this.pollingStatus = { state: "failed", attempt: this.pollingStatus.attempt, retryable: true }; },
    ).finally(() => { if (this.scheduledPoll === tracked) this.scheduledPoll = undefined; });
    this.scheduledPoll = tracked;
  }
  startPolling(schedule: typeof setInterval = setInterval): void { if (this.pollTimer || this.settings.pollIntervalSeconds <= 0) return; this.pollTimer = schedule(() => { this.runScheduledPoll(); }, this.settings.pollIntervalSeconds * 1_000); this.pollTimer.unref?.(); }
  stopPolling(): void { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = undefined; }
}

const registry = new Map<string, DeliveryService>();
export function registerDeliveryService(workspace: string, settings: DeliveryRuntimeSettings, providerFactory?: (config: DeliveryProviderConfig, settings: DeliveryRuntimeSettings) => DeliveryProvider): DeliveryService { const resolved = `${workspace}:${sha256(canonical(settings))}`; let service = registry.get(resolved); if (service) return service; for (const [key, current] of registry) if (key.startsWith(`${workspace}:`)) { current.stopPolling(); registry.delete(key); } service = providerFactory ? new DeliveryService(workspace, settings, providerFactory) : new DeliveryService(workspace, settings); service.startPolling(); registry.set(resolved, service); return service; }
export function registeredDeliveryServices(providerConfigId: string): DeliveryService[] { return [...registry.values()].filter((service) => service.settings.providers.some((provider) => provider.id === providerConfigId && !provider.disabled)); }
export function clearRegisteredDeliveryServicesForTests(): void { for (const service of registry.values()) service.stopPolling(); registry.clear(); }
