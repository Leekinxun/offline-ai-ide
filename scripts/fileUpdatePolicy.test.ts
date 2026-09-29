import assert from "node:assert/strict";
import test from "node:test";
import type { OpenFile } from "../frontend/src/types/index.js";
import {
  applyFileSaveResult,
  applyRemoteFileRename,
  applyRemoteFileSnapshot,
  beginFileRead,
  buildClearedRemoteState,
  createFileReadScope,
  invalidateFileRead,
  isCurrentFileRead,
  isSameWorkspacePath,
  normalizeWorkspaceRelativePath,
  retainOpenFilesAfterTreeRefresh,
  type FileSnapshot,
  type RemoteFileRename,
} from "../frontend/src/editor/fileUpdatePolicy.js";

const file = (overrides: Partial<OpenFile> = {}): OpenFile => ({
  path: "src/main.ts", name: "main.ts", language: "typescript",
  content: "saved", modified: false, version: "v1", updatedAt: 1,
  ...buildClearedRemoteState(), ...overrides,
});

test("AI update retains unsaved text and its save baseline, with remote diff available", () => {
  const dirty = file({ content: "my unfinished edit", modified: true });
  const result = applyRemoteFileSnapshot(dirty, { content: "agent edit", source: "assistant_tool" });
  assert.equal(result.content, dirty.content);
  assert.equal(result.modified, true);
  assert.equal(result.version, "v1");
  assert.equal(result.remoteContent, "agent edit");
  assert.equal(result.remoteUpdated, true);
  assert.equal(result.remoteConflictSource, "assistant_tool");
  const reread = applyRemoteFileSnapshot(result, { content: "agent edit", version: "v2", updatedAt: 2 });
  assert.equal(reread.content, dirty.content);
  assert.equal(reread.version, "v1");
  assert.equal(reread.remoteVersion, "v2");
});

test("matching disk content never silently clears unsaved state", () => {
  const dirty = file({ content: "coincides", modified: true });
  const result = applyRemoteFileSnapshot(dirty, { content: "coincides", version: "v2" });
  assert.equal(result.modified, true);
  assert.equal(result.content, "coincides");
  assert.equal(result.remoteUpdated, false);
});

test("polling an unchanged saved baseline does not invent a conflict", () => {
  const dirty = file({ content: "new local text", modified: true });
  assert.equal(applyRemoteFileSnapshot(dirty, { content: "saved", version: "v1" }), dirty);
});

test("keeping local hides the same conflict until the disk changes again", () => {
  const kept = file({ content: "local", modified: true, remoteContent: "remote", remoteVersion: "v2", remoteUpdated: false });
  const same = applyRemoteFileSnapshot(kept, { content: "remote", version: "v2" });
  assert.equal(same.remoteUpdated, false);
  const changed = applyRemoteFileSnapshot(same, { content: "another edit", version: "v3" });
  assert.equal(changed.remoteUpdated, true);
  assert.equal(changed.content, "local");
});

test("clean refresh keeps tab identity and picks up authoritative content and metadata", () => {
  const result = applyRemoteFileSnapshot(file(), { content: "agent", version: "v2", updatedAt: 2 });
  assert.equal(result.path, "src/main.ts");
  assert.equal(result.language, "typescript");
  assert.equal(result.content, "agent");
  assert.equal(result.modified, false);
  assert.equal(result.version, "v2");
});

test("normalized paths share a read generation without conflating case-distinct files", () => {
  const scope = createFileReadScope("C:\\repo");
  const old = beginFileRead(scope, "C:\\repo\\src\\main.ts");
  const latest = beginFileRead(scope, "./src/main.ts");
  assert.equal(isCurrentFileRead(old, scope), false);
  assert.equal(isCurrentFileRead(latest, scope), true);
  assert.equal(normalizeWorkspaceRelativePath("././src/main.ts", "C:/repo"), "src/main.ts");
  assert.equal(isSameWorkspacePath("src\\main.ts", "./src/main.ts", "C:/repo"), true);
  assert.equal(isSameWorkspacePath("src/Main.ts", "src/main.ts", "C:/repo"), false);
});

test("delayed reads cannot restore an older disk version after a newer update", async () => {
  const scope = createFileReadScope("/repo");
  let current = file();
  let release!: (snapshot: FileSnapshot) => void;
  const pending = new Promise<FileSnapshot>((resolve) => { release = resolve; });
  const oldTicket = beginFileRead(scope, current.path);
  const oldRead = pending.then((snapshot) => {
    if (isCurrentFileRead(oldTicket, scope)) current = applyRemoteFileSnapshot(current, snapshot);
  });
  const newTicket = beginFileRead(scope, current.path);
  if (isCurrentFileRead(newTicket, scope)) current = applyRemoteFileSnapshot(current, { content: "newest", version: "v3" });
  release({ content: "stale", version: "v2" });
  await oldRead;
  assert.equal(current.content, "newest");
  assert.equal(current.version, "v3");
});

test("typing during a read preserves the new buffer and records the disk change", async () => {
  const scope = createFileReadScope("/repo");
  let current = file();
  let release!: (snapshot: FileSnapshot) => void;
  const pending = new Promise<FileSnapshot>((resolve) => { release = resolve; });
  const ticket = beginFileRead(scope, current.path);
  const read = pending.then((snapshot) => {
    if (isCurrentFileRead(ticket, scope)) current = applyRemoteFileSnapshot(current, snapshot);
  });
  current = { ...current, content: "typed after request", modified: true };
  release({ content: "disk after AI edit", version: "v2" });
  await read;
  assert.equal(current.content, "typed after request");
  assert.equal(current.modified, true);
  assert.equal(current.remoteContent, "disk after AI edit");
});

test("workspace replacement rejects pending results even when returning to the same path", () => {
  const original = createFileReadScope("/repo");
  const ticket = beginFileRead(original, "src/main.ts");
  assert.equal(isCurrentFileRead(ticket, createFileReadScope("/another-repo")), false);
  assert.equal(isCurrentFileRead(ticket, createFileReadScope("/repo")), false);
});

test("explicit reload, merge, save or tab close invalidates pending rereads", () => {
  const scope = createFileReadScope("/repo");
  const ticket = beginFileRead(scope, "/repo/src/main.ts");
  invalidateFileRead(scope, "./src/main.ts");
  assert.equal(isCurrentFileRead(ticket, scope), false);
  const newTicket = beginFileRead(scope, "src/main.ts");
  assert.equal(isCurrentFileRead(ticket, scope), false);
  assert.equal(isCurrentFileRead(newTicket, scope), true);
});

test("rollback retains dirty tabs, including files removed from disk, and refreshes clean tabs", () => {
  const dirty = file({ content: "unsaved", modified: true });
  const deletedDirty = file({ path: "new.ts", content: "do not lose me", modified: true });
  const clean = file({ path: "clean.ts" });
  const missing = file({ path: "missing.ts" });
  const tabs = retainOpenFilesAfterTreeRefresh([dirty, deletedDirty, clean, missing], new Set(["src/main.ts", "clean.ts"]), "/repo");
  assert.deepEqual(tabs.map((entry) => entry.path), ["src/main.ts", "new.ts", "clean.ts"]);
  const restored = tabs.map((entry) => entry.path === "new.ts" ? entry : applyRemoteFileSnapshot(entry, { content: "restored", version: "v0" }));
  assert.equal(restored[0].content, "unsaved");
  assert.equal(restored[0].remoteContent, "restored");
  assert.equal(restored[1].content, "do not lose me");
  assert.equal(restored[2].content, "restored");
});

test("save acknowledgement does not mark typing after submission clean", () => {
  const submitted = file({ content: "submitted", modified: true });
  const edited = { ...submitted, content: "typed during save" };
  const result = applyFileSaveResult(edited, submitted, { version: "v2", updatedAt: 2 });
  assert.equal(result.content, "typed during save");
  assert.equal(result.modified, true);
  assert.equal(result.version, "v2");
  assert.equal(applyFileSaveResult(submitted, submitted, { version: "v2", updatedAt: 2 }).modified, false);
});

test("save acknowledgements do not replace a newer version or clear a new remote conflict", () => {
  const submitted = file({ content: "submitted", modified: true });
  const newer = file({ content: "newer version", version: "v3" });
  assert.equal(applyFileSaveResult(newer, submitted, { version: "v2", updatedAt: 2 }), newer);
  const conflicted = applyRemoteFileSnapshot(submitted, { content: "agent edit", version: "v3" });
  const result = applyFileSaveResult(conflicted, submitted, { version: "v2", updatedAt: 2 });
  assert.equal(result.content, "submitted");
  assert.equal(result.modified, true);
  assert.equal(result.remoteContent, "agent edit");
  assert.equal(result.remoteUpdated, true);
});

const rename = (overrides: Partial<RemoteFileRename> = {}): RemoteFileRename => ({
  previousPath: "src/main.ts", previousVersion: "v1", path: "src/TASK.md", sourceStatus: 404,
  snapshot: { content: "saved", version: "v1", updatedAt: 2, source: "assistant_tool" }, ...overrides,
});

test("a verified rename migrates the open tab and reads authoritative destination metadata", () => {
  const next = applyRemoteFileRename([file()], rename({ snapshot: { content: "latest disk", version: "v2", updatedAt: 3 } }), "/repo");
  assert.equal(next.length, 1);
  assert.equal(next[0].path, "src/TASK.md");
  assert.equal(next[0].name, "TASK.md");
  assert.equal(next[0].language, "markdown");
  assert.equal(next[0].content, "latest disk");
  assert.equal(next[0].version, "v2");
  assert.equal(next[0].updatedAt, 3);
});

test("rename retains dirty text and its baseline, including typing while the read was pending", () => {
  const dirty = file({ content: "typed during rename", modified: true });
  const moved = applyRemoteFileRename([dirty], rename(), "/repo")[0];
  assert.equal(moved.path, "src/TASK.md");
  assert.equal(moved.content, dirty.content);
  assert.equal(moved.modified, true);
  assert.equal(moved.version, "v1");
  assert.equal(moved.remoteUpdated, false, "An unchanged moved baseline is not a remote conflict");
  const changed = applyRemoteFileRename([dirty], rename({ snapshot: { content: "destination changed", version: "v2" } }), "/repo")[0];
  assert.equal(changed.content, dirty.content);
  assert.equal(changed.version, "v1");
  assert.equal(changed.remoteContent, "destination changed");
  assert.equal(changed.remoteVersion, "v2");
});

test("rename refuses recreated or unverified sources and never overwrites an open destination", () => {
  const tabs = [file({ modified: true, content: "unsaved source" })];
  for (const sourceStatus of [200, 403, 409, 500, undefined]) {
    assert.equal(applyRemoteFileRename(tabs, rename({ sourceStatus }), "/repo"), tabs);
  }
  for (const previousVersion of ["", "another-version"]) {
    assert.equal(applyRemoteFileRename(tabs, rename({ previousVersion }), "/repo"), tabs);
  }
  const recreated = [file({ version: "new-source" })];
  assert.equal(applyRemoteFileRename(recreated, rename(), "/repo"), recreated);
  const withDestination = [...tabs, file({ path: "src/TASK.md", content: "unsaved destination", modified: true })];
  assert.equal(applyRemoteFileRename(withDestination, rename(), "/repo"), withDestination);
  assert.equal(applyRemoteFileRename(tabs, rename({ snapshot: { content: "no version" } }), "/repo"), tabs);
});

test("rename replay cannot create duplicate tabs, restore closed tabs or move through an invalid path", () => {
  const moved = applyRemoteFileRename([file()], rename(), "/repo");
  assert.equal(applyRemoteFileRename(moved, rename(), "/repo"), moved);
  const closed: OpenFile[] = [];
  assert.equal(applyRemoteFileRename(closed, rename(), "/repo"), closed);
  for (const path of ["", "src/main.ts", "../outside.ts"]) {
    const tabs = [file()];
    assert.equal(applyRemoteFileRename(tabs, rename({ path }), "/repo"), tabs);
  }
});

test("rename evidence is invalidated by either file generation or workspace replacement", () => {
  for (const changed of ["source", "target", "workspace"]) {
    const scope = createFileReadScope("/repo");
    const source = beginFileRead(scope, "src/main.ts");
    const target = beginFileRead(scope, "src/TASK.md");
    let currentScope = scope;
    if (changed === "source") invalidateFileRead(scope, source.path);
    if (changed === "target") beginFileRead(scope, target.path);
    if (changed === "workspace") currentScope = createFileReadScope("/repo");
    let tabs = [file({ modified: true, content: "preserve me" })];
    const original = tabs;
    if (isCurrentFileRead(source, currentScope) && isCurrentFileRead(target, currentScope)) tabs = applyRemoteFileRename(tabs, rename(), "/repo");
    assert.equal(tabs, original, changed);
  }
});
