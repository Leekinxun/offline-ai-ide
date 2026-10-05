import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { useFileSystem } from "../src/hooks/useFileSystem";
import {
  isCurrentTreeRequest,
  replaceDirectoryChildren,
  useWorkspaceFiles,
  type UseWorkspaceFilesOptions,
  type UseWorkspaceFilesReturn,
} from "../src/hooks/useWorkspaceFiles";
import type { FileNode, OpenFile } from "../src/types";
import { DesktopWorkspaceChanges } from "../../backend/src/desktop/nativeWorkspaceChanges";

type HookOverrides = Partial<UseWorkspaceFilesOptions>;

function captureHook(overrides: HookOverrides = {}): UseWorkspaceFilesReturn {
  let captured!: UseWorkspaceFilesReturn;
  const ignore = () => {};
  function Fixture() {
    captured = useWorkspaceFiles({
      fs: { fetchTree: async () => [] } as unknown as UseWorkspaceFilesOptions["fs"],
      showToast: ignore,
      t: value => value,
      setOpenFiles: ignore,
      setActiveFilePath: ignore,
      setDiffViewerPath: ignore,
      setPreviewModes: ignore,
      setEditorNavigationTarget: ignore,
      setEditorHighlightTarget: ignore,
      removeDeletedEntriesFromState: ignore,
      ...overrides,
    });
    return null;
  }
  renderToString(<Fixture />);
  return captured;
}

function captureFileSystem(token = "token"): ReturnType<typeof useFileSystem> {
  let captured!: ReturnType<typeof useFileSystem>;
  function Fixture() {
    captured = useFileSystem(token);
    return null;
  }
  renderToString(<Fixture />);
  return captured;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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

test("desktop file tree requests encode lazy directory paths without changing web callers", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const body = String(input).startsWith("/api/files/paths")
        ? JSON.stringify({ paths: ["src/App.tsx"], truncated: true })
        : "[]";
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const fs = captureFileSystem("tree-token");
    await fs.fetchTree();
    await fs.fetchTree({ path: "src/components" });
    assert.deepEqual(await fs.searchPaths("App"), { paths: ["src/App.tsx"], truncated: true });
    await fs.fetchTree({ expectedWorkspaceDir: "/workspace/v3" });
    await fs.fetchTree({ path: "src/components", expectedWorkspaceDir: "/workspace/v3" });
    await fs.searchPaths("App", { expectedWorkspaceDir: "/workspace/v3" });
    assert.deepEqual(calls, [
      "/api/files/tree",
      "/api/files/tree?path=src%2Fcomponents",
      "/api/files/paths?query=App",
      "/api/files/tree?expectedWorkspaceDir=%2Fworkspace%2Fv3",
      "/api/files/tree?path=src%2Fcomponents&expectedWorkspaceDir=%2Fworkspace%2Fv3",
      "/api/files/paths?query=App&expectedWorkspaceDir=%2Fworkspace%2Fv3",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web and legacy reverse root responses keep the original full-tree behavior", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNow = Date.now;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Date.now = () => 700;
    const pending = [deferred<FileNode[]>(), deferred<FileNode[]>()];
    const prunedOpenFiles: string[][] = [];
    let calls = 0;
    const fs = {
      fetchTree: () => {
        return pending[calls++].promise;
      },
    } as unknown as UseWorkspaceFilesOptions["fs"];
    const hook = captureHook({
      fs,
      setOpenFiles: (update) => {
        const previous = [
          { path: "old.txt" },
          { path: "new.txt" },
        ] as OpenFile[];
        prunedOpenFiles.push(
          (typeof update === "function" ? update(previous) : update).map((file) => file.path)
        );
      },
    });

    const first = hook.loadTree();
    const second = hook.loadTree();
    pending[1].resolve([{ name: "new.txt", path: "new.txt", type: "file" }]);
    assert.equal(await second, true);
    pending[0].resolve([{ name: "old.txt", path: "old.txt", type: "file" }]);
    assert.equal(await first, true);
    assert.deepEqual(prunedOpenFiles, [["new.txt"], ["old.txt"]]);
    assert.equal(hook.lastWorkspaceMtimeRef.current, 700);
  } finally {
    Date.now = originalNow;
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Tauri reverse root responses cannot restore an older tree after a newer refresh wins", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { crownforgeDesktop: { workspaceChanges: "cursor" } } });
    const pending = [deferred<FileNode[]>(), deferred<FileNode[]>()];
    const signals: AbortSignal[] = [];
    let calls = 0;
    const fs = {
      fetchTree: ({ signal }: { signal?: AbortSignal } = {}) => {
        if (signal) signals.push(signal);
        return pending[calls++].promise;
      },
    } as unknown as UseWorkspaceFilesOptions["fs"];
    const hook = captureHook({ fs });

    const first = hook.loadTree();
    const second = hook.loadTree();
    assert.equal(signals[0].aborted, true);
    pending[1].resolve([{ name: "new.txt", path: "new.txt", type: "file" }]);
    assert.equal(await second, true);
    pending[0].resolve([{ name: "old.txt", path: "old.txt", type: "file" }]);
    assert.equal(await first, false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("partial desktop root refresh does not prune open files and failed cursor refresh remains retryable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { crownforgeDesktop: { workspaceChanges: "cursor" } } });
    let openFilePrunes = 0;
    const hook = captureHook({
      fs: {
        fetchTree: async () => [{ name: "src", path: "src", type: "directory", children: [], childrenLoaded: false }],
      } as unknown as UseWorkspaceFilesOptions["fs"],
      setOpenFiles: () => {
        openFilePrunes += 1;
      },
    });
    hook.lastWorkspaceMtimeRef.current = 10_000;
    assert.equal(await hook.loadTree(), true);
    assert.equal(openFilePrunes, 0);
    assert.equal(hook.lastWorkspaceMtimeRef.current, 10_000);

    const failingHook = captureHook({
      fs: { fetchTree: async () => { throw new Error("boom"); } } as unknown as UseWorkspaceFilesOptions["fs"],
    });
    failingHook.lastWorkspaceMtimeRef.current = 20_000;
    assert.equal(await failingHook.loadTree(), false);
    assert.equal(failingHook.lastWorkspaceMtimeRef.current, 20_000);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("lazy directory children replace only the requested branch and mark it loaded", () => {
  const tree: FileNode[] = [
    { name: "src", path: "src", type: "directory", children: [], childrenLoaded: false },
    { name: "README.md", path: "README.md", type: "file" },
  ];
  const next = replaceDirectoryChildren(tree, "src", [
    { name: "App.tsx", path: "src/App.tsx", type: "file" },
  ]);
  assert.notEqual(next, tree);
  assert.deepEqual(next[0], {
    name: "src",
    path: "src",
    type: "directory",
    childrenLoaded: true,
    children: [{ name: "App.tsx", path: "src/App.tsx", type: "file" }],
  });
  assert.equal(next[1], tree[1]);
});

test("tree request scope guard rejects stale workspace generations", () => {
  assert.equal(isCurrentTreeRequest({
    aborted: false,
    requestGeneration: 2,
    currentGeneration: 2,
    requestScope: "token\u0000/workspace-a",
    currentScope: "token\u0000/workspace-a",
  }), true);
  assert.equal(isCurrentTreeRequest({
    aborted: false,
    requestGeneration: 2,
    currentGeneration: 3,
    requestScope: "token\u0000/workspace-a",
    currentScope: "token\u0000/workspace-a",
  }), false);
  assert.equal(isCurrentTreeRequest({
    aborted: false,
    requestGeneration: 2,
    currentGeneration: 2,
    requestScope: "token\u0000/workspace-a",
    currentScope: "token\u0000/workspace-b",
  }), false);
});
