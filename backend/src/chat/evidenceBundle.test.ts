import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { createEvidenceBundle, verifyEvidenceBundle, type EvidenceBundleV1 } from "../artifacts/evidenceBundle.js";
import { EvidenceBundleExportStore } from "../artifacts/evidenceBundleStore.js";
import { canonicalJson, sha256 } from "../artifacts/reviewArtifact.js";
import { checkpointsRouter } from "../routes/checkpoints.js";
import { changeSetReviewRevision } from "./changeSets.js";
import { createArtifactFixture } from "./artifactTestSupport.js";

function parse(bytes: Buffer): EvidenceBundleV1 { return JSON.parse(bytes.toString("utf8")) as EvidenceBundleV1; }
function encode(value: EvidenceBundleV1): Buffer { return Buffer.from(canonicalJson(value), "utf8"); }
function rebuild(value: EvidenceBundleV1): Buffer {
  value.manifest.entries = value.entries.map(({ path, mediaType, role, bytes, sha256: digest }) => ({ path, mediaType, role, bytes, sha256: digest })).sort((a, b) => a.path.localeCompare(b.path));
  value.manifest.payloadDigest = `sha256:${sha256(canonicalJson({ bindings: value.manifest.bindings, entries: value.manifest.entries }))}`;
  return encode(value);
}
function replaceEntry(value: EvidenceBundleV1, name: string, content: Buffer): void { const item = value.entries.find((entry) => entry.path === name)!; item.content = content.toString("base64"); item.bytes = content.byteLength; item.sha256 = crypto.createHash("sha256").update(content).digest("hex"); }
async function withApi(workspace: string, run: (baseUrl: string) => Promise<void>): Promise<void> { const app = express(); app.use(express.json({ limit: "40mb" })); app.use((req, _res, next) => { (req as any).userSession = { workspaceDir: workspace, username: "operator", token: `bundle-${Date.now()}`, isAdmin: true }; next(); }); app.use(checkpointsRouter); const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address === "object"); try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } }

test("air-gapped bundle is deterministic, unsigned but integrity verified, bound, and applicable", async (t) => {
  const fixture = await createArtifactFixture(t, { withFinding: true });
  const revision = changeSetReviewRevision(fixture.changeSet); const first = createEvidenceBundle(fixture.workspace, fixture.changeSet.id, revision); const second = createEvidenceBundle(fixture.workspace, fixture.changeSet.id, revision);
  assert.deepEqual(first, second); fs.writeFileSync(path.join(fixture.workspace, "human-unrelated.txt"), "preserve me\n"); const afterHumanEdit = createEvidenceBundle(fixture.workspace, fixture.changeSet.id, revision); assert.deepEqual(afterHumanEdit, first);
  const before = execFileSync("git", ["-C", fixture.workspace, "status", "--porcelain=v1"], { encoding: "utf8" });
  const verification = verifyEvidenceBundle(fixture.workspace, first); const after = execFileSync("git", ["-C", fixture.workspace, "status", "--porcelain=v1"], { encoding: "utf8" });
  assert.equal(verification.integrity, "verified"); assert.equal(verification.authenticity, "unsigned"); assert.equal(verification.bindings, "verified");
  assert.deepEqual(verification.applicability, { baseAvailable: true, patchApplies: true, changedFilesMatch: true }); assert.equal(after, before);
  const text = first.toString("utf8"); assert(!text.includes(fixture.secret)); assert(!text.includes(fixture.workspace)); assert(!text.includes("ownerToken")); assert(!text.includes("raw_output"));
});

test("optional graph references contain only sanitized identifiers and remain generically verifiable", async (t) => {
  const fixture = await createArtifactFixture(t);
  const bytes = createEvidenceBundle(fixture.workspace, fixture.changeSet.id, undefined, { includeGraphReferences: true });
  const bundle = parse(bytes);
  const graphEntry = bundle.entries.find((item) => item.role === "graph_references");
  assert(graphEntry);
  const references = JSON.parse(Buffer.from(graphEntry.content, "base64").toString("utf8"));

  assert.deepEqual(Object.keys(references).sort(), ["boundChangeSetIds", "boundRunIds", "criticalEventIds", "edgeIds", "graphRevision", "nodeIds", "schemaVersion"].sort());
  assert.deepEqual(references.boundChangeSetIds, [fixture.changeSet.id]);
  assert.equal(references.nodeIds.includes(`change_set:${fixture.changeSet.id}`), true);
  assert.equal(typeof references.graphRevision, "string");
  assert.doesNotMatch(JSON.stringify(references), /path|prompt|output|reasoning|secret/i);
  assert.equal(verifyEvidenceBundle(fixture.workspace, bytes).integrity, "verified");
});

test("bundle verification fails closed for tampering, unsafe paths, collisions, links, compression, and oversized payloads", async (t) => {
  const fixture = await createArtifactFixture(t); const original = createEvidenceBundle(fixture.workspace, fixture.changeSet.id);
  const tampered = parse(original); const patch = tampered.entries.find((entry) => entry.path === "payload/change.patch")!; patch.content = Buffer.from("tamper").toString("base64"); assert.equal(verifyEvidenceBundle(fixture.workspace, encode(tampered)).integrity, "failed");
  const traversal = parse(original); traversal.entries[0].path = "../escape"; assert(verifyEvidenceBundle(fixture.workspace, encode(traversal)).issues.some((item) => item.code === "unsafe_path"));
  const collision = parse(original); collision.entries.push({ ...collision.entries[0], path: collision.entries[0].path.toUpperCase() }); collision.manifest.entries.push({ ...collision.manifest.entries[0], path: collision.manifest.entries[0].path.toUpperCase() }); assert(verifyEvidenceBundle(fixture.workspace, encode(collision)).issues.some((item) => item.code === "duplicate_path"));
  const link = parse(original) as any; link.entries[0].kind = "symlink"; assert(verifyEvidenceBundle(fixture.workspace, encode(link)).issues.some((item) => item.code === "unsupported_entry"));
  const hardlink = parse(original) as any; hardlink.entries[0].kind = "hardlink"; assert(verifyEvidenceBundle(fixture.workspace, encode(hardlink)).issues.some((item) => item.code === "unsupported_entry"));
  const compressed = parse(original) as any; compressed.entries[0].compression = "gzip"; assert(verifyEvidenceBundle(fixture.workspace, encode(compressed)).issues.some((item) => item.code === "unsupported_entry"));
  const oversized = parse(original); replaceEntry(oversized, "payload/trace.ndjson", Buffer.alloc(16 * 1024 * 1024 + 1)); assert(verifyEvidenceBundle(fixture.workspace, rebuild(oversized)).issues.some((item) => item.code === "entry_integrity"));
});

test("cryptographically consistent cross-artifact binding tampering is rejected", async (t) => {
  const fixture = await createArtifactFixture(t); const bundle = parse(createEvidenceBundle(fixture.workspace, fixture.changeSet.id));
  const run = JSON.parse(Buffer.from(bundle.entries.find((entry) => entry.path === "payload/run.json")!.content, "base64").toString("utf8")); run.conversationId = "other-conversation";
  replaceEntry(bundle, "payload/run.json", Buffer.from(canonicalJson(run), "utf8")); const verification = verifyEvidenceBundle(fixture.workspace, rebuild(bundle));
  assert.equal(verification.integrity, "failed"); assert.equal(verification.bindings, "failed"); assert(verification.issues.some((item) => item.code === "binding_mismatch"));
});

test("signature policy is separated from unsigned payload integrity", async (t) => {
  const fixture = await createArtifactFixture(t); const verification = verifyEvidenceBundle(fixture.workspace, createEvidenceBundle(fixture.workspace, fixture.changeSet.id, undefined, { requireSignature: true }));
  assert.equal(verification.integrity, "verified"); assert.equal(verification.bindings, "verified"); assert.equal(verification.authenticity, "unsigned"); assert(verification.issues.some((item) => item.code === "signature_required"));
});

test("bundle export refuses recognizable secrets in immutable patch bytes", async (t) => {
  const fixture = await createArtifactFixture(t, { patchContent: "const token = 'sk_patchsecret123';\n" });
  assert.throws(() => createEvidenceBundle(fixture.workspace, fixture.changeSet.id), /secret material/i);
});

test("durable asynchronous export reaches ready, reuses an identical request, and downloads verified bytes", async (t) => {
  const fixture = await createArtifactFixture(t); const store = new EvidenceBundleExportStore(fixture.workspace); const revision = changeSetReviewRevision(fixture.changeSet); const scheduled = store.schedule(fixture.changeSet.id, revision);
  let ready = store.get(scheduled.exportId); for (let attempt = 0; attempt < 200 && ready.status !== "ready" && ready.status !== "failed"; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); ready = store.get(scheduled.exportId); }
  assert.equal(ready.status, "ready", ready.error); const duplicate = store.schedule(fixture.changeSet.id, revision); assert.equal(duplicate.exportId, scheduled.exportId);
  const bytes = store.download(scheduled.exportId); assert.equal(bytes.byteLength, ready.bytes); assert.equal(verifyEvidenceBundle(fixture.workspace, bytes).bundleId, ready.bundleId);
  const tampered = parse(bytes); const patchEntry = tampered.entries.find((entry) => entry.path === "payload/change.patch")!; patchEntry.content = `${patchEntry.content[0] === "A" ? "B" : "A"}${patchEntry.content.slice(1)}`;
  fs.writeFileSync(path.join(fixture.workspace, ".history", "evidence-bundles", `${scheduled.exportId}.cfbundle`), encode(tampered));
  assert.throws(() => store.download(scheduled.exportId), /integrity/i);
});

test("existing corrupt evidence export state fails closed and is preserved", async (t) => {
  const fixture = await createArtifactFixture(t); const target = path.join(fixture.workspace, ".history", "evidence-bundle-exports.json");
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "{corrupt-export-state");
  assert.throws(() => new EvidenceBundleExportStore(fixture.workspace).list(), (error: unknown) => (error as { code?: string }).code === "evidence_bundle_persistence_invalid");
  assert.equal(fs.readFileSync(target, "utf8"), "{corrupt-export-state");
});

test("review, SARIF, async export, download, and read-only verify routes expose the stable contract", async (t) => {
  const fixture = await createArtifactFixture(t, { withFinding: true });
  await withApi(fixture.workspace, async (baseUrl) => {
    const revision = changeSetReviewRevision(fixture.changeSet); const reviewResponse = await fetch(`${baseUrl}/change-sets/${fixture.changeSet.id}/review-artifact?revision=${revision}&format=crewforge`); assert.equal(reviewResponse.status, 200); assert.match(reviewResponse.headers.get("content-type") || "", /crewforge\.review/); const review = await reviewResponse.json() as any; assert.equal(review.scope.changeSetId, fixture.changeSet.id);
    const sarifResponse = await fetch(`${baseUrl}/change-sets/${fixture.changeSet.id}/review-artifact?format=sarif`); assert.equal(sarifResponse.status, 200); assert.match(sarifResponse.headers.get("content-type") || "", /sarif/); assert.equal((await sarifResponse.json() as any).version, "2.1.0");
    const scheduledResponse = await fetch(`${baseUrl}/change-sets/${fixture.changeSet.id}/bundle-exports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision }) }); assert.equal(scheduledResponse.status, 202); const scheduled = await scheduledResponse.json() as any; const id = scheduled.export.exportId;
    let record: any; for (let attempt = 0; attempt < 200; attempt += 1) { const response = await fetch(`${baseUrl}/bundle-exports/${id}`); assert.equal(response.status, 200); record = (await response.json() as any).export; if (record.status === "ready" || record.status === "failed") break; await new Promise((resolve) => setTimeout(resolve, 10)); } assert.equal(record.status, "ready", record.error);
    const download = await fetch(`${baseUrl}/bundle-exports/${id}/download`); assert.equal(download.status, 200); assert.match(download.headers.get("content-type") || "", /crewforge\.evidence-bundle/); const bytes = Buffer.from(await download.arrayBuffer());
    const verified = await fetch(`${baseUrl}/bundles/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundleBase64: bytes.toString("base64") }) }); assert.equal(verified.status, 200); const verification = (await verified.json() as any).verification; assert.equal(verification.integrity, "verified"); assert.equal(verification.authenticity, "unsigned"); assert.equal(verification.bindings, "verified");
  });
});
