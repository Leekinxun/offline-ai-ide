import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileSha256, runtimeBuildId, validateSourceLock, buildCrownForgeCodexRuntime } from "./build-crownforge-codex-runtime.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-source-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = "desktop/rust/windows-sandbox-patches/crownforge-network-v1.patch";
  const patch = path.join(root, relative); fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, "reviewed patch fixture\n");
  const lock = { runtimeVariant: "crownforge-network-v1", runtimeVersion: "0.160.0", sourceTag: "rust-v0.160.0",
    upstreamCommit: "a956835d020762cb2b570053af06f643a11c0ecc", sourceRepository: "https://github.com/openai/codex",
    patchFile: relative, patchSha256: fileSha256(patch), buildProfile: "release" };
  return { root, patch, lock };
}

test("the reviewed source lock identifies exact upstream, patch and downstream build", t => {
  const { root, patch, lock } = fixture(t);
  assert.equal(validateSourceLock(root, lock), patch);
  assert.equal(runtimeBuildId(lock), `${lock.runtimeVariant}:${lock.upstreamCommit}:${lock.patchSha256}`);
  const changed = { ...lock, patchSha256: "a".repeat(64) };
  assert.notEqual(runtimeBuildId(changed), runtimeBuildId(lock), "Patch changes must invalidate the compiled-runtime identity");
  fs.appendFileSync(patch, "unreviewed change\n");
  assert.throws(() => validateSourceLock(root, lock), /checksum mismatch/);
});

test("source substitution, unpinned patches and path redirection are rejected before building", t => {
  const { root, patch, lock } = fixture(t);
  for (const mutation of [
    { upstreamCommit: "b".repeat(40) }, { sourceRepository: "https://example.org/codex" },
    { runtimeVersion: "0.162.0" }, { runtimeVariant: "official" }, { buildProfile: "dev" },
    { patchSha256: "0".repeat(64) }, { patchFile: "../unreviewed.patch" },
  ]) assert.throws(() => validateSourceLock(root, { ...lock, ...mutation }), /Invalid/);
  if (process.platform !== "win32") {
    const copy = `${patch}.real`; fs.renameSync(patch, copy); fs.symlinkSync(copy, patch);
    assert.throws(() => validateSourceLock(root, lock), /checksum mismatch/);
  }
});

test("streaming checksums match the published bytes and a wrong-host build performs no setup", t => {
  const { root, lock } = fixture(t);
  const large = path.join(root, "binary"); const bytes = crypto.randomBytes(2 * 1024 * 1024 + 7); fs.writeFileSync(large, bytes);
  assert.equal(fileSha256(large), crypto.createHash("sha256").update(bytes).digest("hex"));
  if (process.platform !== "win32") assert.throws(() => buildCrownForgeCodexRuntime({ project: root, lock, arch: "x64" }), /Build.*Windows/);
});
