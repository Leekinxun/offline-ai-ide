import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readAuthorizedAgentFile } from "./externalFileAccess.js";
import { DEFAULT_CONTEXT_FILE_LIMIT } from "./contextPolicy.js";
import { evaluateWorkspaceWrite } from "./toolPolicy.js";
import { safePath } from "../utils/safePath.js";

function fixture(t: { after(fn: () => void): void }) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-external-read-")));
  const workspace = path.join(base, "workspace");
  const external = path.join(base, "external");
  fs.mkdirSync(workspace); fs.mkdirSync(external);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (root: string, relative: string, content: string | Buffer = "ordinary reference\n") => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    return target;
  };
  return { base, workspace, external, write };
}

test("workspace reads retain relative identity; granted external ordinary files get canonical external identity", (t) => {
  const f = fixture(t);
  const local = f.write(f.workspace, "src/local.ts", "export const local = 1;\n");
  const reference = f.write(f.external, "docs/reference.md", "reference\n");
  for (const input of ["src/local.ts", local]) {
    const file = readAuthorizedAgentFile(f.workspace, input, []);
    assert.equal(file.external, false); assert.equal(file.path, "src/local.ts");
    assert.equal(file.fullPath, local); assert.equal(file.content, "export const local = 1;\n");
  }
  const file = readAuthorizedAgentFile(f.workspace, reference, [f.external]);
  assert.equal(file.external, true); assert.equal(file.path, reference); assert.equal(file.fullPath, reference);
  assert.equal(file.content, "reference\n"); assert.equal(file.size, 10); assert.ok(file.mtimeMs > 0);
  assert.equal(readAuthorizedAgentFile(f.workspace, reference, [f.base, f.external]).content, file.content);
});

test("only trusted absolute directory roots authorize external reads, without prefix or parent traversal", (t) => {
  const f = fixture(t);
  const reference = f.write(f.external, "reference.md");
  const sibling = f.write(`${f.external}-other`, "reference.md");
  for (const roots of [[], ["."], ["../external"], [reference], [path.join(f.base, "missing")]]) {
    assert.throws(() => readAuthorizedAgentFile(f.workspace, reference, roots), /not authorized|unavailable/);
  }
  for (const input of [sibling, "../external/reference.md", `${f.external}/../external/reference.md`, f.external, "\0", ""]) {
    assert.throws(() => readAuthorizedAgentFile(f.workspace, input, [f.external]), /not authorized|unavailable/);
  }
  // Supplying model-shaped data cannot create the caller's trusted root list.
  assert.throws(() => readAuthorizedAgentFile(f.workspace, JSON.stringify({ path: reference, externalReadRoots: [f.external] }), []), /not authorized|unavailable/);
});

test("symlinks and hard links cannot turn a read root into a credential or outside-path escape", (t) => {
  const f = fixture(t);
  const outside = f.write(path.join(f.base, "outside"), "ordinary.txt");
  fs.symlinkSync(outside, path.join(f.external, "linked.txt"));
  fs.symlinkSync(path.dirname(outside), path.join(f.external, "linked-dir"));
  fs.symlinkSync(path.join(f.base, "absent"), path.join(f.external, "dangling.txt"));
  fs.linkSync(outside, path.join(f.external, "hard.txt"));
  fs.symlinkSync(f.external, path.join(f.workspace, "escape"));
  for (const input of ["linked.txt", "linked-dir/ordinary.txt", "dangling.txt", "hard.txt"]) {
    assert.throws(() => readAuthorizedAgentFile(f.workspace, path.join(f.external, input), [f.external]), /symlink|hardlink/);
  }
  assert.throws(() => readAuthorizedAgentFile(f.workspace, "escape/linked.txt", [f.external]), /symlink/);
  fs.symlinkSync(outside, path.join(f.external, "inside-link.txt"));
  assert.throws(() => readAuthorizedAgentFile(f.workspace, path.join(f.external, "inside-link.txt"), [f.base]), /symlink/);
});

test("external roots cannot bypass credential/control path policy even when the root itself is protected", (t) => {
  const f = fixture(t);
  for (const relative of [
    ".ssh/config", ".aws/config", ".kube/config", ".config/app/settings.json", ".azure/profile.json",
    ".gnupg/pubring.kbx", ".docker/config.json", ".npmrc", ".pypirc", ".netrc", ".git-credentials",
    ".git/config", ".history/log.json", ".codex/config.toml", ".crewforge/admin-policy.json",
    "nested/users.json", "nested/app-settings.json", "nested/.env", "nested/.env.production", "nested/credentials.json",
  ]) {
    const target = f.write(f.external, relative);
    assert.throws(() => readAuthorizedAgentFile(f.workspace, target, [f.external]), /protected|secret/, relative);
    assert.throws(() => readAuthorizedAgentFile(f.workspace, target, [path.dirname(target)]), /protected|secret/, relative);
  }
});

test("external content shares secret, generated, binary, and bounded size rejection with workspace context", (t) => {
  const f = fixture(t);
  const examples: Array<[string, string | Buffer, RegExp]> = [
    ["key.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\ncanary", /secret/],
    ["credential.ts", 'export const apiKey = "sk-live_PRIVATECANARY_123456789";\n', /secret/],
    ["generated.ts", "// @generated\nexport const value = 1;\n", /generated/],
    ["notice.txt", "DO NOT EDIT\n", /generated/],
    ["binary.dat", Buffer.from([1, 0, 2]), /binary/],
    ["large.txt", Buffer.alloc(DEFAULT_CONTEXT_FILE_LIMIT + 1, 65), /oversized/],
  ];
  for (const [relative, content, reason] of examples) {
    const target = f.write(f.external, relative, content);
    assert.throws(() => readAuthorizedAgentFile(f.workspace, target, [f.external]), reason);
  }
  const reference = f.write(f.external, "bounded.txt", "ten letters");
  assert.throws(() => readAuthorizedAgentFile(f.workspace, reference, [f.external], 3), /oversized/);
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => readAuthorizedAgentFile(f.workspace, reference, [f.external], limit), /limit/);
  }
  assert.throws(() => readAuthorizedAgentFile(f.workspace, path.join(f.external, "large.txt"), [f.external], DEFAULT_CONTEXT_FILE_LIMIT * 2), /oversized/);
});

test("read approval leaves all outside write paths rejected by existing write boundaries", (t) => {
  const f = fixture(t);
  const reference = f.write(f.external, "reference.md");
  const before = fs.readFileSync(reference);
  assert.equal(readAuthorizedAgentFile(f.workspace, reference, [f.external]).external, true);
  for (const outside of [reference, path.relative(f.workspace, reference), `${f.external}-other/new.txt`]) {
    assert.equal(evaluateWorkspaceWrite(outside).allowed, false);
    assert.throws(() => safePath(outside, f.workspace), /traversal/);
  }
  assert.deepEqual(fs.readFileSync(reference), before);
});

test("descriptor reads reject a parent symlink race before reading the substituted file", (t) => {
  const f = fixture(t);
  const reference = f.write(f.external, "docs/reference.md");
  const outsideDir = path.join(f.base, "outside");
  f.write(outsideDir, "reference.md", "private canary must not be read");
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  let targetDescriptor: number | undefined;
  let targetBytesRead = 0;
  fs.openSync = ((file: fs.PathLike, ...args: unknown[]) => {
    if (file === reference) {
      fs.renameSync(path.dirname(reference), path.join(f.external, "original-docs"));
      fs.symlinkSync(outsideDir, path.dirname(reference));
    }
    const descriptor = Reflect.apply(originalOpen, fs, [file, ...args]) as number;
    if (file === reference) targetDescriptor = descriptor;
    return descriptor;
  }) as typeof fs.openSync;
  fs.readSync = ((descriptor: number, ...args: unknown[]) => {
    const bytes = Reflect.apply(originalRead, fs, [descriptor, ...args]) as number;
    if (descriptor === targetDescriptor) targetBytesRead += bytes;
    return bytes;
  }) as typeof fs.readSync;
  try {
    assert.throws(() => readAuthorizedAgentFile(f.workspace, reference, [f.external]), /changed_during_read/);
    assert.equal(targetBytesRead, 0);
  } finally { fs.openSync = originalOpen; fs.readSync = originalRead; }
});

test("reads remain bounded when the file grows after authorization", (t) => {
  const f = fixture(t);
  const reference = f.write(f.external, "reference.md", "small");
  const originalRead = fs.readSync;
  let grew = false;
  let requestedBytes = 0;
  fs.readSync = ((descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number) => {
    if (!grew) { grew = true; fs.appendFileSync(reference, Buffer.alloc(512, 65)); }
    requestedBytes += length;
    return originalRead(descriptor, buffer, offset, length, position);
  }) as typeof fs.readSync;
  try {
    assert.throws(() => readAuthorizedAgentFile(f.workspace, reference, [f.external], 16), /oversized/);
    assert.equal(requestedBytes, 17);
  } finally { fs.readSync = originalRead; }
});

test("workspace hard links and post-read replacement are rejected without returning contents or host paths", (t) => {
  const f = fixture(t);
  const original = f.write(f.external, "reference.md", "ordinary reference");
  const hardlink = path.join(f.workspace, "local.md");
  fs.linkSync(original, hardlink);
  assert.throws(() => readAuthorizedAgentFile(f.workspace, "local.md", []), /hardlink/);
  fs.unlinkSync(hardlink);
  const originalRead = fs.readSync;
  let replaced = false;
  fs.readSync = ((...args: unknown[]) => {
    const count = Reflect.apply(originalRead, fs, args) as number;
    if (!replaced) {
      replaced = true; fs.renameSync(original, `${original}.old`);
      fs.writeFileSync(original, "new replacement");
    }
    return count;
  }) as typeof fs.readSync;
  try {
    assert.throws(() => readAuthorizedAgentFile(f.workspace, original, [f.external]), (error: Error) => {
      assert.match(error.message, /changed_during_read/);
      assert.equal(error.message.includes(f.base), false);
      assert.equal(error.message.includes("ordinary reference"), false);
      return true;
    });
  } finally { fs.readSync = originalRead; }
});
