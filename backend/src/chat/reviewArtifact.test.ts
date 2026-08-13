import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewArtifact, canonicalJson, sha256, toSarifReviewArtifact } from "../artifacts/reviewArtifact.js";
import { changeSetReviewRevision } from "./changeSets.js";
import { createArtifactFixture } from "./artifactTestSupport.js";

test("review artifact binds exact scope, independent actors, findings, evidence, and a stable digest", async (t) => {
  const fixture = await createArtifactFixture(t, { withFinding: true });
  const revision = changeSetReviewRevision(fixture.changeSet); const artifact = buildReviewArtifact(fixture.workspace, fixture.changeSet.id, revision);
  assert.deepEqual(artifact.scope, { conversationId: "conversation-1", executionPlanId: fixture.plan.id, parentRunId: "parent-run-1", childRunId: "child-run-1", worktreeId: fixture.worktree.id, changeSetId: fixture.changeSet.id, revision, patchContentSha256: fixture.changeSet.patchSha256, baseSha: fixture.changeSet.baseSha, headSha: fixture.changeSet.headSha });
  assert.equal(artifact.reviewRuns.filter((run) => run.stage === "review" && run.status === "completed").length, 1);
  assert.equal(artifact.reviewRuns.filter((run) => run.stage === "reverify" && run.status === "completed").length, 1);
  assert.equal(artifact.findings[0].lifecycle, "verified");
  assert.notEqual(artifact.findings[0].reviewer?.id, artifact.findings[0].verifier?.id);
  assert.equal(artifact.findings[0].reviewer?.revision, changeSetReviewRevision(fixture.originalChangeSet));
  assert.equal(artifact.findings[0].verifier?.revision, changeSetReviewRevision(fixture.changeSet));
  assert.equal(artifact.reviewRuns.find((run) => run.stage === "reverify")?.verificationResults?.[0]?.status, "verified");
  assert.equal(artifact.gate.decision, "ready");
  assert(artifact.evidenceIndex.some((item) => item.kind === "finding_evidence"));
  assert(artifact.evidenceIndex.some((item) => item.kind === "test_output"));
  const { artifactDigest: _digest, ...body } = artifact;
  assert.equal(artifact.artifactDigest, `sha256:${sha256(canonicalJson(body))}`);
  const serialized = canonicalJson(artifact);
  assert(!serialized.includes("ownerPid")); assert(!serialized.includes("ownerToken")); assert(!serialized.includes("leaseExpiresAt")); assert(!serialized.includes(fixture.secret));
  assert(!serialized.includes(fixture.workspace));
});

test("SARIF export preserves authoritative CrewForge scope and lifecycle", async (t) => {
  const fixture = await createArtifactFixture(t, { withFinding: true }); const artifact = buildReviewArtifact(fixture.workspace, fixture.changeSet.id);
  const sarif = toSarifReviewArtifact(artifact); const run = sarif.runs[0] as any;
  assert.equal(sarif.version, "2.1.0"); assert.equal(run.properties.crewforge.artifactDigest, artifact.artifactDigest);
  assert.deepEqual(run.properties.crewforge.scope, artifact.scope); assert.equal(run.results[0].properties.crewforge.lifecycle, "verified");
  assert.equal(run.results[0].ruleIndex, 0); assert.equal(run.tool.driver.rules[0].id, run.results[0].ruleId);
});

test("review artifact rejects a stale requested revision", async (t) => {
  const fixture = await createArtifactFixture(t); assert.throws(() => buildReviewArtifact(fixture.workspace, fixture.changeSet.id, "0".repeat(64)), /stale/i);
});
