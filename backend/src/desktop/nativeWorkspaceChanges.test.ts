import assert from "node:assert/strict";
import test from "node:test";
import { DesktopWorkspaceChanges } from "./nativeWorkspaceChanges.js";

test("desktop refresh watermarks cover multiple viewers, epoch changes and backwards clocks", async () => {
  let now = 1_000, epoch = "first", revision = 0;
  const tracker = new DesktopWorkspaceChanges(async (_workspace, after) => ({
    cursor: { epoch, revision }, changed: !after || after.epoch !== epoch || after.revision !== revision, rescanRequired: false,
  }), () => now);
  const first = await tracker.read("/workspace", 0);
  assert.deepEqual(first, { changed: true, latestMtime: 1_000 });
  assert.deepEqual(await tracker.read("/workspace", first.latestMtime), { changed: false, latestMtime: 1_000 });
  assert.equal((await tracker.read("/workspace", 0)).changed, true, "A second viewer must not consume another viewer's refresh");
  revision++;
  now = 500;
  const mutation = await tracker.read("/workspace", first.latestMtime);
  assert.deepEqual(mutation, { changed: true, latestMtime: 1_001 });
  assert.equal((await tracker.read("/workspace", first.latestMtime)).changed, true);
  epoch = "restarted"; revision = 0;
  const restart = await tracker.read("/workspace", 1_001);
  assert.deepEqual(restart, { changed: true, latestMtime: 1_002 });
  const freshBackend = new DesktopWorkspaceChanges(async () => ({ cursor: { epoch, revision }, changed: true, rescanRequired: false }), () => 500);
  assert.deepEqual(await freshBackend.read("/workspace", 9_000), { changed: true, latestMtime: 9_001 }, "A restarted Node service must advance a restored client watermark");
});

test("concurrent change queries serialize cursors and a failed request never acknowledges a change", async () => {
  const seen: unknown[] = [];
  let revision = 0, fail = false, active = 0;
  const tracker = new DesktopWorkspaceChanges(async (_workspace, after) => {
    assert.equal(active++, 0, "Only one native version query may update a workspace watermark at a time");
    seen.push(after);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (fail) { fail = false; throw new Error("runtime disconnected"); }
    return { cursor: { epoch: "epoch", revision }, changed: !after || after.revision !== revision, rescanRequired: false };
  }, () => 1_000);
  const values = await Promise.all([tracker.read("/workspace", 0), tracker.read("/workspace", 0)]);
  assert.deepEqual(values, [{ changed: true, latestMtime: 1_000 }, { changed: true, latestMtime: 1_000 }]);
  assert.deepEqual(seen, [undefined, { epoch: "epoch", revision: 0 }]);
  revision++; fail = true;
  await assert.rejects(tracker.read("/workspace", 1_000), /runtime disconnected/);
  assert.deepEqual(await tracker.read("/workspace", 1_000), { changed: true, latestMtime: 1_001 });
  assert.deepEqual(seen.slice(-2), [{ epoch: "epoch", revision: 0 }, { epoch: "epoch", revision: 0 }]);
});

test("a restored future watermark cannot hide a change observed first by another viewer", async () => {
  let now = 1_000, revision = 0;
  const tracker = new DesktopWorkspaceChanges(async (_workspace, after) => ({
    cursor: { epoch: "epoch", revision }, changed: !after || after.revision !== revision, rescanRequired: false,
  }), () => now);
  const viewerA = await tracker.read("/workspace", 0);
  const viewerB = await tracker.read("/workspace", 9_000);
  assert.deepEqual(viewerB, { changed: true, latestMtime: 9_001 });
  assert.deepEqual(await tracker.read("/workspace", viewerB.latestMtime), { changed: false, latestMtime: 9_001 });
  revision++; now = 500;
  const nextA = await tracker.read("/workspace", viewerA.latestMtime);
  assert.deepEqual(nextA, { changed: true, latestMtime: 9_002 });
  assert.deepEqual(await tracker.read("/workspace", viewerB.latestMtime), { changed: true, latestMtime: 9_002 });
});

test("rescan requests force a refresh, invalid native results and cancellation cannot advance a cursor", async () => {
  let malformed = false, rescanRequired = false;
  const seen: unknown[] = [];
  const tracker = new DesktopWorkspaceChanges(async (_workspace, after) => {
    seen.push(after);
    return { cursor: { epoch: "epoch", revision: malformed ? NaN : 0 }, changed: false, rescanRequired };
  }, () => 1_000);
  await tracker.read("/workspace", 0);
  malformed = true;
  await assert.rejects(tracker.read("/workspace", 1_000), /Invalid desktop change version/);
  malformed = false; rescanRequired = true;
  assert.deepEqual(await tracker.read("/workspace", 1_000), { changed: true, latestMtime: 1_001 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tracker.read("/workspace", 1_001, controller.signal), /cancelled/);
  assert.equal(seen.length, 3);
  for (const since of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) await assert.rejects(tracker.read("/workspace", since), /Invalid desktop change watermark/);
});

test("cancellation after a native response does not acknowledge its cursor", async () => {
  const controller = new AbortController();
  const seen: unknown[] = [];
  let cancel = true;
  const tracker = new DesktopWorkspaceChanges(async (_workspace, after) => {
    seen.push(after);
    if (cancel) { controller.abort(); cancel = false; }
    return { cursor: { epoch: "epoch", revision: 1 }, changed: true, rescanRequired: false };
  }, () => 1_000);
  await assert.rejects(tracker.read("/workspace", 0, controller.signal), /cancelled/);
  assert.deepEqual(await tracker.read("/workspace", 0), { changed: true, latestMtime: 1_000 });
  assert.deepEqual(seen, [undefined, undefined]);
});

test("idle tracker capacity is reclaimed by elapsed time despite a backwards clock", async () => {
  let now = 1_000_000, elapsed = 0;
  const tracker = new DesktopWorkspaceChanges(async (workspace) => ({ cursor: { epoch: workspace, revision: 0 }, changed: true, rescanRequired: false }), () => now, () => elapsed);
  for (let i = 0; i < 64; i++) await tracker.read(`/workspace-${i}`, 0);
  await assert.rejects(tracker.read("/new-workspace", 0), /tracker is full/);
  now = 500; elapsed = 600_001;
  assert.deepEqual(await tracker.read("/new-workspace", 0), { changed: true, latestMtime: 500 });
});
