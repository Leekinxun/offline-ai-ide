import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../frontend/src/i18n/messages.js";

interface ReleaseFixture {
  responsiveBaselines: Array<{ id: string; component: string; componentTokens: string[]; cssTokens: string[] }>;
}

interface VisualFixture {
  schemaVersion: number;
  baselines: Array<{ file: string; width: number; height: number; sha256: string }>;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseFixture = JSON.parse(fs.readFileSync(path.join(root, "scripts/fixtures/ws14-release-contract.json"), "utf8")) as ReleaseFixture;
const visualFixture = JSON.parse(fs.readFileSync(path.join(root, "scripts/fixtures/ws15-visual-baselines.json"), "utf8")) as VisualFixture;
const criticalLocaleKeys = [
  "chat.approval.planTitle", "chat.approval.approvePlan", "chat.approval.rejectPlan",
  "chat.amendmentPending", "chat.approve", "chat.reject",
  "recovery.changeSets", "recovery.changeSetsHint", "recovery.startReview", "recovery.apply",
  "recovery.applyReviewBlocked", "recovery.rollback", "recovery.rollbackConfirm", "recovery.rollbackFailed",
  "recovery.changeSetStatus.needs_attention", "recovery.needsAttentionDescription", "recovery.needsAttentionActions",
  "recovery.legacyChangeSetReadOnly",
  "problems.validationRequest", "problems.session.error",
  "delivery.reviewPublish", "delivery.publish", "delivery.bindingConflict",
  "bundle.build", "bundle.verify", "bundle.revisionLocked",
] as const;

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]).sort();
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

test("critical frontend flows have complete English and Chinese messages", () => {
  for (const key of criticalLocaleKeys) {
    const english = EN_MESSAGES[key];
    const chinese = ZH_CN_MESSAGES[key];
    assert.ok(english?.trim(), `missing English message: ${key}`);
    assert.ok(chinese?.trim(), `missing Chinese message: ${key}`);
    assert.deepEqual(placeholders(chinese), placeholders(english), `placeholder mismatch: ${key}`);
  }
});

test("English and Chinese core dictionaries remain structurally identical", () => {
  const englishKeys = Object.keys(EN_MESSAGES).sort();
  const chineseKeys = Object.keys(ZH_CN_MESSAGES).sort();
  assert.deepEqual(chineseKeys, englishKeys);
  for (const key of englishKeys) {
    assert.deepEqual(placeholders(ZH_CN_MESSAGES[key]), placeholders(EN_MESSAGES[key]), `placeholder mismatch: ${key}`);
  }
});

test("recorded visual baselines retain exact dimensions and approved digests", () => {
  assert.equal(visualFixture.schemaVersion, 1);
  assert.equal(visualFixture.baselines.length, 5);
  const viewports = new Set<string>();
  for (const baseline of visualFixture.baselines) {
    const bytes = fs.readFileSync(path.join(root, baseline.file));
    assert.ok(bytes.length >= 10_000, `${baseline.file} is not a credible recorded baseline`);
    assert.deepEqual(jpegDimensions(bytes), { width: baseline.width, height: baseline.height }, baseline.file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), baseline.sha256, `${baseline.file} digest drifted`);
    viewports.add(`${baseline.width}x${baseline.height}`);
  }
  assert.deepEqual([...viewports].sort(), ["1024x800", "1280x720", "768x800"]);
});

test("responsive baseline components retain their viewport state contracts", () => {
  const css = fs.readFileSync(path.join(root, "frontend/src/App.css"), "utf8");
  assert.equal(releaseFixture.responsiveBaselines.length, 4);
  for (const baseline of releaseFixture.responsiveBaselines) {
    const component = fs.readFileSync(path.join(root, baseline.component), "utf8");
    for (const token of baseline.componentTokens) assert.ok(component.includes(token), `${baseline.id} missing component token ${token}`);
    for (const token of baseline.cssTokens) assert.ok(css.includes(token), `${baseline.id} missing CSS token ${token}`);
  }
});
