import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const sources = {
  gitHook: read("frontend/src/hooks/useGitDelivery.ts"),
  providerHook: read("frontend/src/hooks/useProviderDelivery.ts"),
  bundleHook: read("frontend/src/hooks/useOfflineBundles.ts"),
  findingsHook: read("frontend/src/hooks/useFindings.ts"),
  gitPanel: read("frontend/src/components/GitPanel.tsx"),
  approval: read("frontend/src/components/OperationApprovalDialog.tsx"),
  providerPanel: read("frontend/src/components/ProviderDeliveryPanel.tsx"),
  changeSummary: read("frontend/src/components/ChangeSummary.tsx"),
  runDetails: read("frontend/src/components/RunDetailsPanel.tsx"),
  safeExternalLink: read("frontend/src/components/SafeExternalLink.tsx"),
  app: read("frontend/src/App.tsx"),
  backendIndex: read("backend/src/index.ts"),
  deliveryRoute: read("backend/src/routes/delivery.ts"),
};

function requireText(source, text, description) {
  if (!source.includes(text)) throw new Error(`Delivery UI contract failed: ${description} (missing ${JSON.stringify(text)})`);
}
function forbidText(source, text, description) {
  if (source.includes(text)) throw new Error(`Delivery UI contract failed: ${description} (unexpected ${JSON.stringify(text)})`);
}

requireText(sources.backendIndex, 'app.use("/api/git-delivery"', "local Git backend is mounted");
requireText(sources.backendIndex, 'app.use("/api/delivery"', "provider delivery backend is mounted");
requireText(sources.gitHook, 'const API = "/api/git-delivery"', "local Git hook uses the canonical route");
requireText(sources.gitHook, '"Idempotency-Key"', "local Git prepare is idempotent");
requireText(sources.gitHook, "approvalDigest: operation.preflight.approvalDigest", "approval is bound to the reviewed preflight");
requireText(sources.gitHook, "expectedVersion: operation.version", "local Git writes use CAS");
requireText(sources.providerHook, 'const API = "/api/delivery"', "provider hook uses the canonical route");
requireText(sources.deliveryRoute, 'deliveryRouter.post("/operations"', "server-owned provider preflight is available");
requireText(sources.providerHook, 'fetch(`${API}/operations`', "provider publication starts with server-owned preflight");
requireText(sources.providerHook, '/approve`', "provider publication uses server-owned approval");
requireText(sources.providerHook, '/publish`', "provider publication writes only an approved operation");
requireText(sources.providerHook, "approvalDigest: operation.approvalDigest", "provider approval is bound to the server digest");
requireText(sources.providerHook, "expectedVersion: operation.version", "provider approval and publish use CAS");
requireText(sources.providerHook, '"Idempotency-Key": idempotencyKey', "provider preflight is idempotent");
requireText(sources.providerHook, "publicationRequestDigest(input, serverBindingHint)", "publication fields and immutable binding select the idempotency ledger entry");
requireText(sources.providerHook, "reusablePending", "pending publication retries keep a stable key");
requireText(sources.providerHook, "crypto.randomUUID()", "changed or terminal publication requests receive a new key");
requireText(sources.providerHook, 'normalized.code === "idempotency_conflict"', "server digest changes invalidate the stale idempotency key");
requireText(sources.providerHook, "/follow-ups/${encodeURIComponent(item.id)}/approve", "provider feedback approval uses the durable route");
requireText(sources.providerHook, "!body.feedback.taskId || !body.feedback.followUpRunId", "incomplete follow-up lineage is rejected");
for (const route of ["/review-artifact?", "/bundle-exports", "/download", "/api/checkpoints/bundles/verify"]) {
  requireText(sources.bundleHook, route, `offline artifacts use ${route}`);
}
requireText(sources.findingsHook, "allowedTransitions", "finding actions respect server transitions");
requireText(sources.findingsHook, "expectedVersion: finding.version", "finding transitions use CAS");
requireText(sources.findingsHook, "/application\\/sarif\\+json/i", "SARIF export validates the backend media type");
requireText(sources.findingsHook, 'payload.version !== "2.1.0"', "SARIF export validates the schema");
forbidText(sources.findingsHook, 'method: "DELETE"', "finding deletion is replaced by an audited lifecycle transition");
forbidText(sources.changeSummary, "deleteFinding", "finding UI has no destructive delete entry");
requireText(sources.gitPanel, 'role="tablist"', "delivery sections use accessible tabs");
requireText(sources.gitPanel, 'event.key === "ArrowRight"', "delivery tabs support arrow navigation");
requireText(sources.gitPanel, 'event.key === "Home"', "delivery tabs support Home navigation");
requireText(sources.gitPanel, "aria-controls", "delivery tabs expose panel relationships");
requireText(sources.approval, 'aria-modal="true"', "external writes require an accessible approval dialog");
requireText(sources.approval, "useModalDialogFocus", "approval uses the shared focus trap and focus-return contract");
requireText(sources.providerPanel, "<OperationApprovalDialog", "provider publish and feedback are explicitly approved");
forbidText(sources.providerPanel, "controller.deliveries[0]", "delivery update never falls back to an unrelated binding");
requireText(sources.providerPanel, "item.revision === selectedRevision", "delivery update requires exact capture-integrity revision binding");
requireText(sources.providerPanel, "item.patchContentSha256 === selectedPatchContentSha256", "delivery update requires exact patch-content binding");
requireText(sources.providerPanel, "bindingConflict", "delivery binding conflicts remain visible");
requireText(sources.providerPanel, "item.followUpRunId", "follow-up run evidence is rendered");
requireText(sources.safeExternalLink, "safeExternalHref", "external hrefs use a shared safety boundary");
requireText(sources.safeExternalLink, 'parsed.protocol === "https:"', "external links require HTTPS");
requireText(sources.safeExternalLink, "parsed.username || parsed.password", "external links reject URL credentials");
requireText(sources.safeExternalLink, 'rel: "noopener noreferrer"', "new-tab links isolate the opener and referrer");
requireText(sources.providerPanel, "<SafeExternalLink", "provider and check links use the safe external link boundary");
requireText(sources.runDetails, "<SafeExternalLink", "run delivery links use the safe external link boundary");
forbidText(sources.providerPanel, "<a href={current.remote.url}", "provider URL is never rendered directly");
forbidText(sources.runDetails, "<a href={delivery.remote.url}", "run delivery URL is never rendered directly");
requireText(sources.changeSummary, 'exportFindings("sarif")', "review findings can export SARIF");
requireText(sources.runDetails, '"delivery"', "run details expose delivery evidence");
requireText(sources.app, "onOpenFollowUpRun", "follow-up run evidence can be opened");
requireText(sources.app, "chat.loadRun(followUpRunId)", "follow-up navigation loads the exact run");

console.log("CrewForge delivery UI contract passed.");
