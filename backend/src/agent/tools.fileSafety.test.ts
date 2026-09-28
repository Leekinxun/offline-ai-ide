import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFileVersion, listFileMutations } from "../files/mutationRegistry.js";
import { atomicWriteFile, replaceUniqueText } from "./fileEditSafety.js";
import { runReadFile, TOOL_DISPATCH, type ToolHandler } from "./tools.js";

function fixture(t: test.TestContext, content = "before\n") {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-safe-edit-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const target = path.join(workspaceDir, "code.txt");
  fs.writeFileSync(target, content);
  const context = { workspaceDir, actorName: "primary", runId: "run-1", toolCallId: "tool-1" } as Parameters<ToolHandler>[1];
  const invoke = async (name: string, args: Record<string, unknown>, overrides: Partial<Parameters<ToolHandler>[1]> = {}) => {
    const result = await TOOL_DISPATCH[name]({ path: "code.txt", ...args }, { ...context, ...overrides });
    return typeof result === "string" ? result : result.output;
  };
  return { workspaceDir, target, context, invoke, content: () => fs.readFileSync(target, "utf8") };
}

test("writes require a current read and reject another run's or actor's read", async (t) => {
  const f = fixture(t);
  assert.match(await f.invoke("write_file", { content: "after" }), /^Error: Read code.txt before/);
  await f.invoke("read_file", {});
  assert.match(await f.invoke("write_file", { content: "after" }, { runId: "run-2" }), /^Error: Read/);
  assert.match(await f.invoke("edit_file", { old_text: "before", new_text: "after" }, { actorName: "teammate" }), /^Error: Read/);
  assert.equal(f.content(), "before\n");
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("read then external save rejects both whole-file write and targeted edit without recording a mutation", async (t) => {
  const f = fixture(t);
  await f.invoke("read_file", {});
  fs.writeFileSync(f.target, "before\nuser addition\n");
  assert.match(await f.invoke("write_file", { content: "after\n" }), /^Error: File changed since it was read/);
  assert.match(await f.invoke("edit_file", { old_text: "before", new_text: "after" }), /^Error: File changed since it was read/);
  assert.equal(f.content(), "before\nuser addition\n");
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
  await f.invoke("read_file", {});
  assert.match(await f.invoke("edit_file", { old_text: "before", new_text: "after" }), /^Edited/);
  assert.equal(f.content(), "after\nuser addition\n");
});

test("a read followed by external deletion cannot silently recreate the file", async (t) => {
  const f = fixture(t);
  await f.invoke("read_file", {});
  fs.unlinkSync(f.target);
  assert.match(await f.invoke("write_file", { content: "after" }), /^Error: File changed/);
  assert.equal(fs.existsSync(f.target), false);
});

test("explicit versions support resumed requests but cannot bypass stale checks", async (t) => {
  const f = fixture(t);
  const read = JSON.parse(await f.invoke("read_file", {}));
  assert.equal(read.version, buildFileVersion("before\n"));
  assert.match(await f.invoke("write_file", { content: "after", expected_version: read.version }, { runId: "resumed" }), /^Wrote/);
  assert.match(await f.invoke("write_file", { content: "outdated", expected_version: read.version }), /^Error: File changed/);
  assert.match(await f.invoke("write_file", { content: "bad", expected_version: 42 }), /^Error: expected_version/);
  assert.match(await f.invoke("write_file", { content: "bad", expected_version: "missing" }), /^Error: File changed/);
  assert.equal(f.content(), "after");
});

test("successful edits advance only the current agent's version and preserve each mutation", async (t) => {
  const f = fixture(t, "A");
  await f.invoke("read_file", {});
  await f.invoke("read_file", {}, { actorName: "other" });
  assert.match(await f.invoke("edit_file", { old_text: "A", new_text: "B" }), /^Edited/);
  assert.match(await f.invoke("edit_file", { old_text: "B", new_text: "C" }, { toolCallId: "tool-2" }), /^Edited/);
  assert.match(await f.invoke("write_file", { content: "D" }, { toolCallId: "tool-3" }), /^Wrote/);
  assert.match(await f.invoke("edit_file", { old_text: "D", new_text: "E" }, { actorName: "other" }), /^Error: File changed/);
  assert.deepEqual(["tool-1", "tool-2", "tool-3"].map((toolCallId) => listFileMutations(f.workspaceDir, { toolCallId })[0]?.preimageContent), ["A", "B", "C"]);
  assert.equal(f.content(), "D");
});

test("edit_file rejects empty and overlapping ambiguous matches without writing", async (t) => {
  const f = fixture(t, "aaaa");
  await f.invoke("read_file", {});
  assert.match(await f.invoke("edit_file", { old_text: "", new_text: "insert" }), /^Error: old_text must be non-empty/);
  assert.match(await f.invoke("edit_file", { old_text: "aaa", new_text: "one" }), /matches multiple locations/);
  assert.equal(f.content(), "aaaa");
  assert.equal(listFileMutations(f.workspaceDir).length, 0);
});

test("LF search blocks safely match uniform CRLF files and preserve newline encoding", async (t) => {
  const f = fixture(t, "first\r\nsecond\r\nlast\r\n");
  await f.invoke("read_file", {});
  assert.match(await f.invoke("edit_file", { old_text: "first\nsecond", new_text: "first\nchanged\ninserted" }), /^Edited/);
  assert.equal(f.content(), "first\r\nchanged\r\ninserted\r\nlast\r\n");
  assert.throws(() => replaceUniqueText("one\r\ntwo\r\none\r\ntwo", "one\ntwo", "x"), /matches multiple/);
  assert.equal(replaceUniqueText("a\nb\n", "a\r\nb", "a\r\nc").content, "a\nc\n");
  assert.throws(() => replaceUniqueText("a\r\nb\nc", "a\nb", "z"), /Text not found/);
  assert.throws(() => replaceUniqueText("  indentation", " indentation!", "x"), /Text not found/);
});

test("replacement strings are literal, including JavaScript replacement metacharacters", () => {
  assert.equal(replaceUniqueText("before TARGET after", "TARGET", "$& $` $' $$").content, "before $& $` $' $$ after");
});

test("read_file returns bounded versioned pages with line and character continuation", async (t) => {
  const original = Array.from({ length: 8_000 }, (_, index) => `${index}: a sample line\r\n`).join("");
  const f = fixture(t, original);
  let result = JSON.parse(await f.invoke("read_file", {}));
  assert.equal(result.path, "code.txt");
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.version, buildFileVersion(original));
  assert.ok(!JSON.stringify(result).includes(f.workspaceDir));
  let reconstructed = result.content;
  while (result.truncated) {
    assert.ok(result.content.length <= 50_000);
    result = JSON.parse(await f.invoke("read_file", { offset: result.next_offset }));
    reconstructed += result.content;
  }
  assert.equal(reconstructed, original);
  // Reading every page, not just the first page, authorizes a complete rewrite.
  assert.match(await f.invoke("write_file", { content: `${original}tail` }), /^Wrote/);
});

test("start_line and offset use consistent line units, preserve delimiters, and validate arguments", async (t) => {
  const f = fixture(t, "one\r\ntwo\r\nthree");
  const byLine = JSON.parse(await f.invoke("read_file", { start_line: 2, limit: 1 }));
  const byOffset = JSON.parse(await f.invoke("read_file", { offset: 1, limit: 1 }));
  assert.deepEqual(byLine, byOffset);
  assert.equal(byLine.content, "two\r\n");
  assert.equal(byLine.next_offset, 2);
  assert.equal(byLine.next_start_line, 3);
  assert.equal(byLine.next_character_offset, 10);
  for (const args of [{ limit: 0 }, { limit: 1.2 }, { offset: -1 }, { start_line: 0 }, { offset: 9 }, { character_offset: 999 }, { offset: 0, start_line: 1 }]) {
    assert.match(await f.invoke("read_file", args), /^Error:/);
  }
});

test("oversized single lines have an explicit bounded character continuation without splitting a surrogate pair", async (t) => {
  const original = "x".repeat(49_999) + "😀" + "y".repeat(60_000);
  const f = fixture(t, original);
  let page = JSON.parse(await f.invoke("read_file", {}));
  assert.equal(page.content.length, 49_999);
  assert.equal(page.next_offset, null);
  assert.equal(page.next_character_offset, 49_999);
  let reconstructed = page.content;
  while (page.truncated) {
    page = JSON.parse(await f.invoke("read_file", { character_offset: page.next_character_offset }));
    assert.ok(page.content.length <= 50_000);
    reconstructed += page.content;
  }
  assert.equal(reconstructed, original);
});

test("a partial read cannot implicitly authorize replacing unread content, while a focused edit can proceed", async (t) => {
  const f = fixture(t, "first\nsecond\nthird\n");
  await f.invoke("read_file", { limit: 1 });
  assert.match(await f.invoke("write_file", { content: "replacement" }), /^Error: Only part/);
  assert.match(await f.invoke("edit_file", { old_text: "first", new_text: "changed" }), /^Edited/);
  assert.match(await f.invoke("write_file", { content: "replacement" }), /^Error: Only part/);
  assert.equal(f.content(), "changed\nsecond\nthird\n");
});

test("new files are created atomically, existing file executable permissions survive replacement", async (t) => {
  const f = fixture(t);
  fs.chmodSync(f.target, 0o751);
  await f.invoke("read_file", {});
  assert.match(await f.invoke("write_file", { content: "updated" }), /^Wrote/);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o751);
  assert.match(await f.invoke("write_file", { path: "new/sub/file.txt", content: "created", expected_version: "missing" }), /^Wrote/);
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, "new/sub/file.txt"), "utf8"), "created");
  assert.equal(fs.readdirSync(f.workspaceDir).some((name) => name.includes(".agent-")), false);
});

test("atomic replacement rechecks concurrent changes and leaves no partial file or temporary artifact", (t) => {
  const f = fixture(t);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = ((file, ...args: unknown[]) => {
    Reflect.apply(originalWrite, fs, [file, ...args]);
    if (typeof file === "number") originalWrite(f.target, "concurrent user content");
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(() => atomicWriteFile(f.workspaceDir, "code.txt", "agent content", "before\n"), /File changed before committing/);
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(f.content(), "concurrent user content");
  assert.deepEqual(fs.readdirSync(f.workspaceDir), ["code.txt"]);
});

test("symlink aliases cannot read or edit files, even with an explicit version", async (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.target, path.join(f.workspaceDir, "alias.txt"));
  assert.match(await f.invoke("read_file", { path: "alias.txt" }), /^Error:.*symlink/);
  assert.match(await f.invoke("write_file", { path: "alias.txt", content: "bad", expected_version: buildFileVersion("before\n") }), /^Error:.*symbolic links/);
  assert.equal(f.content(), "before\n");
  assert.ok(fs.lstatSync(path.join(f.workspaceDir, "alias.txt")).isSymbolicLink());
});

test("read_file retains context policy limits and handles empty files", async (t) => {
  const f = fixture(t, "");
  const empty = JSON.parse(await runReadFile("code.txt", undefined, f.workspaceDir));
  assert.equal(empty.content, "");
  assert.equal(empty.complete, true);
  assert.equal(empty.next_character_offset, null);
  assert.match(await f.invoke("write_file", { path: "../outside.txt", content: "bad" }), /^Error:/);
  fs.writeFileSync(path.join(f.workspaceDir, ".env"), "A=placeholder");
  assert.match(await runReadFile(".env", undefined, f.workspaceDir), /^Error: Context file is not authorized: secret/);
  fs.writeFileSync(f.target, "x".repeat(1024 * 1024 + 1));
  assert.match(await f.invoke("read_file", {}), /^Error: Context file is not authorized: oversized/);
  assert.match(await f.invoke("write_file", { content: "small", expected_version: buildFileVersion(f.content()) }), /^Error: Context file is not authorized: oversized/);
});

test("explicit versions cannot bypass context authorization for existing secret or generated content", async (t) => {
  const f = fixture(t, 'const password = "liveCredential1234";\n');
  assert.match(await f.invoke("edit_file", { old_text: "const", new_text: "let", expected_version: buildFileVersion(f.content()) }), /^Error: Context file is not authorized: secret/);
  fs.writeFileSync(f.target, "// @generated\nconst a = 1;\n");
  assert.match(await f.invoke("write_file", { content: "replacement", expected_version: buildFileVersion(f.content()) }), /^Error: Context file is not authorized: generated/);
  assert.equal(f.content(), "// @generated\nconst a = 1;\n");
});

test("a corrupt mutation journal blocks edits and creates before touching workspace files", async (t) => {
  const f = fixture(t);
  await f.invoke("read_file", {});
  fs.mkdirSync(path.join(f.workspaceDir, ".checkpoints"));
  fs.writeFileSync(path.join(f.workspaceDir, ".checkpoints", "mutations.json"), "{corrupt");
  assert.match(await f.invoke("write_file", { content: "after" }), /^Error: Mutation journal evidence/);
  assert.match(await f.invoke("edit_file", { old_text: "before", new_text: "after" }), /^Error: Mutation journal evidence/);
  assert.match(await f.invoke("write_file", { path: "new.txt", content: "after" }), /^Error: Mutation journal evidence/);
  assert.equal(f.content(), "before\n");
  assert.equal(fs.existsSync(path.join(f.workspaceDir, "new.txt")), false);
});
