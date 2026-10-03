import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { useWorkspaceFiles, type UseWorkspaceFilesOptions, type UseWorkspaceFilesReturn } from "../src/hooks/useWorkspaceFiles";
import { DesktopWorkspaceChanges } from "../../backend/src/desktop/nativeWorkspaceChanges";

function captureHook(): UseWorkspaceFilesReturn {
  let captured!: UseWorkspaceFilesReturn;
  const ignore = () => {};
  function Fixture() {
    captured = useWorkspaceFiles({ fs: { fetchTree: async () => [] } as unknown as UseWorkspaceFilesOptions["fs"],
      showToast: ignore, t: value => value, setOpenFiles: ignore, setActiveFilePath: ignore, setDiffViewerPath: ignore,
      setPreviewModes: ignore, setEditorNavigationTarget: ignore, setEditorHighlightTarget: ignore, removeDeletedEntriesFromState: ignore });
    return null;
  }
  renderToString(<Fixture />);
  return captured;
}

test("a Tauri poll refresh preserves its acknowledged cursor through loadTree and clock rollback", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNow = Date.now;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { crownforgeDesktop: { workspaceChanges: "cursor" } } });
    Date.now = () => 500;
    const hook = captureHook();
    assert.equal(hook.lastWorkspaceMtimeRef.current, 0);
    await hook.loadTree();
    assert.equal(hook.lastWorkspaceMtimeRef.current, 0, "The initial tree load must not replace the native cursor with the client clock");
    const tracker = new DesktopWorkspaceChanges(async (_workspace, after) => ({ cursor: { epoch: "epoch", revision: 0 }, changed: !after, rescanRequired: false }), () => 500);
    const result = await tracker.read("/workspace", 9_000);
    hook.lastWorkspaceMtimeRef.current = result.latestMtime; // The existing App polling contract.
    await hook.loadTree();
    assert.equal(hook.lastWorkspaceMtimeRef.current, 9_001);
    assert.equal((await tracker.read("/workspace", hook.lastWorkspaceMtimeRef.current)).changed, false);
  } finally {
    Date.now = originalNow;
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Web and the legacy desktop bridge retain tree timestamp behavior", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window"), originalNow = Date.now;
  try {
    Date.now = () => 500;
    for (const windowValue of [{}, { crownforgeDesktop: { platform: "darwin", version: "legacy" } }]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
      const hook = captureHook(); hook.lastWorkspaceMtimeRef.current = 9_001;
      await hook.loadTree(); assert.equal(hook.lastWorkspaceMtimeRef.current, 500);
    }
  } finally {
    Date.now = originalNow;
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window");
  }
});
