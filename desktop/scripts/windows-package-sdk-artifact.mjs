// Download accepted build bytes only; this module never fetches SDK source or
// invokes its compiler. Archive digest failures are fatal, not action warnings.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SDK_PRODUCER } from "./windows-package-validation.mjs";
import { verifyCodexRuntime } from "./prepare-codex-runtime.mjs";

export async function writeVerifiedArchive(response, destination, expectedHash, limit = 512 * 1024 * 1024) {
  assert.equal(response.status, 200, "Accepted SDK artifact archive download failed");
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  assert.ok(response.body, "Accepted artifact archive body is missing");
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.partial`;
  const hash = crypto.createHash("sha256"); let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) { done(new Error("Accepted SDK artifact exceeds its archive limit")); return; }
      hash.update(chunk); done(null, chunk);
    } }), fs.createWriteStream(temporary, { flags: "wx" }));
    assert.ok(bytes > 0, "Accepted SDK archive is empty");
    const actual = hash.digest("hex");
    assert.equal(actual, expectedHash, "Accepted SDK artifact archive SHA-256 mismatch");
    fs.renameSync(temporary, destination);
    return { bytes, sha256: actual };
  } finally { fs.rmSync(temporary, { force: true }); }
}

async function main() {
  assert.equal(process.platform, "win32", "This package lane requires Windows");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, SDK_PRODUCER.repository);
  assert.ok(process.env.GITHUB_TOKEN, "Read-only Actions artifact token is required");
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const directory = path.join(project, ".artifacts/app-rust-package");
  const proofFile = path.join(directory, "sdk-provenance.json");
  const proof = JSON.parse(fs.readFileSync(proofFile, "utf8"));
  assert.deepEqual(proof.producer, SDK_PRODUCER);
  assert.equal(proof.packageCommit, process.env.GITHUB_SHA);
  assert.ok(Number.isSafeInteger(proof.artifactId) && proof.artifactId > 0);
  assert.match(proof.artifactDigest, /^sha256:[a-f0-9]{64}$/);
  const destination = path.join(project, "backend/vendor/codex/win-x64");
  assert.ok(!fs.existsSync(destination), "The accepted SDK artifact requires a fresh destination");
  const response = await fetch(`https://api.github.com/repos/${SDK_PRODUCER.repository}/actions/artifacts/${proof.artifactId}/zip`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const archive = path.join(directory, "accepted-sdk.zip");
  const download = await writeVerifiedArchive(response, archive, proof.artifactDigest.slice(7));
  fs.mkdirSync(destination, { recursive: true });
  const sevenZip = path.join(process.env.ProgramFiles, "7-Zip/7z.exe");
  await promisify(execFile)(sevenZip, ["x", archive, `-o${destination}`, "-y"], { windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  verifyCodexRuntime(destination, "x64");
  proof.downloadedArchive = download;
  fs.writeFileSync(proofFile, `${JSON.stringify(proof, null, 2)}\n`);
  fs.rmSync(archive);
  console.log(JSON.stringify({ acceptedSdkArtifact: proof.artifactId, archiveSha256: download.sha256, sdkVerified: true, sdkSourceBuild: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
