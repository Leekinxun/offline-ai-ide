import assert from "node:assert/strict";
import test from "node:test";
import type { FileTree } from "../frontend/node_modules/@pierre/trees/dist/index.js";
import { buildTreeInput, fromTreePath, getExpandedTreePaths, restoreTreeExpansion, syncTreeSelection } from "../frontend/src/components/fileTreeAdapter.js";
import type { FileNode } from "../frontend/src/types/index.js";

const nodes: FileNode[] = [
  { name: "z-source", path: "z-source", type: "directory", children: [
    { name: "nested", path: "z-source/nested", type: "directory", children: [
      { name: "计划.ts", path: "z-source/nested/计划.ts", type: "file" },
    ] },
    { name: "first.ts", path: "z-source/first.ts", type: "file" },
  ] },
  { name: "empty folder", path: "empty folder", type: "directory", children: [] },
  { name: "a-last.md", path: "a-last.md", type: "file" },
];

async function createModel(treeNodes = nodes) {
  // This repository's standalone .ts tests run through a CommonJS tsx boundary;
  // the library is ESM-only, so load its public entry with native import().
  const { FileTree, preparePresortedFileTreeInput } = await import("../frontend/node_modules/@pierre/trees/dist/index.js");
  const input = buildTreeInput(treeNodes);
  const model = new FileTree({
    preparedInput: preparePresortedFileTreeInput(input.paths),
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
  });
  return { input, model, preparePresortedFileTreeInput };
}

function visiblePaths(model: FileTree) {
  return model.getVisibleRows(0, model.getVisibleCount() - 1).map((row) => row.path);
}

test("Trees input preserves backend ordering, empty directories, and workspace path identity", async (t) => {
  const { input, model } = await createModel();
  t.after(() => model.cleanUp());
  assert.deepEqual(visiblePaths(model), ["z-source/", "empty folder/", "a-last.md"]);
  assert.equal(model.getItem("empty folder")?.isDirectory(), true);
  assert.equal(model.getItem("empty folder/")?.getPath(), "empty folder/");
  assert.equal(fromTreePath("z-source/nested/"), "z-source/nested");
  assert.equal(input.nodesByPath.get("z-source/nested/计划.ts")?.name, "计划.ts");
});

test("public model navigation follows expanded rows and stays at the visible boundaries", async (t) => {
  const { model } = await createModel();
  t.after(() => model.cleanUp());
  model.focusFirstItem();
  model.focusPreviousItem();
  assert.equal(model.getFocusedPath(), "z-source/");
  const directory = model.getItem("z-source");
  assert.ok(directory && "expand" in directory);
  directory.expand();
  model.focusNextItem();
  assert.equal(model.getFocusedPath(), "z-source/nested/");
  model.focusParentItem();
  assert.equal(model.getFocusedPath(), "z-source/");
  model.focusLastItem();
  model.focusNextItem();
  assert.equal(model.getFocusedPath(), "a-last.md");
  directory.collapse();
  assert.deepEqual(visiblePaths(model), ["z-source/", "empty folder/", "a-last.md"]);
});

test("focusing an editor file never adds it to the independent batch-selection set", async (t) => {
  const { model } = await createModel();
  t.after(() => model.cleanUp());
  syncTreeSelection(model, new Set(["empty folder"]));
  model.focusPath("a-last.md");
  assert.equal(model.getFocusedPath(), "a-last.md");
  assert.deepEqual(model.getSelectedPaths(), ["empty folder/"]);
  syncTreeSelection(model, new Set(["a-last.md"]));
  assert.deepEqual(model.getSelectedPaths(), ["a-last.md"]);
  syncTreeSelection(model, new Set());
  assert.deepEqual(model.getSelectedPaths(), []);
});

test("tree refresh restores expansion without discarding existing focus or selection", async (t) => {
  const { input, model, preparePresortedFileTreeInput } = await createModel();
  t.after(() => model.cleanUp());
  for (const path of ["z-source/", "z-source/nested/"]) {
    const item = model.getItem(path);
    assert.ok(item && "expand" in item);
    item.expand();
  }
  model.focusPath("z-source/nested/计划.ts");
  syncTreeSelection(model, new Set(["empty folder"]));
  const expandedPaths = getExpandedTreePaths(model, input.directoryPaths);
  const refreshed = buildTreeInput([...nodes, { name: "new.txt", path: "new.txt", type: "file" }]);
  model.resetPaths({ preparedInput: preparePresortedFileTreeInput(refreshed.paths), initialExpandedPaths: expandedPaths });
  assert.deepEqual(getExpandedTreePaths(model, refreshed.directoryPaths), expandedPaths);
  assert.ok(visiblePaths(model).includes("z-source/nested/计划.ts"));
  assert.equal(model.getFocusedPath(), "z-source/nested/计划.ts");
  assert.deepEqual(model.getSelectedPaths(), ["empty folder/"]);
});

test("filtered trees restore batch selections outside the matching row set when cleared", async (t) => {
  const { input, model, preparePresortedFileTreeInput } = await createModel();
  t.after(() => model.cleanUp());
  const externalSelection = new Set(["a-last.md", "empty folder"]);
  syncTreeSelection(model, externalSelection);
  const filtered = buildTreeInput([nodes[0]]);
  model.resetPaths({ preparedInput: preparePresortedFileTreeInput(filtered.paths), initialExpandedPaths: filtered.directoryPaths });
  syncTreeSelection(model, externalSelection);
  assert.deepEqual(model.getSelectedPaths(), []);
  assert.ok(visiblePaths(model).includes("z-source/nested/计划.ts"));
  model.resetPaths({ preparedInput: preparePresortedFileTreeInput(input.paths), initialExpandedPaths: [] });
  syncTreeSelection(model, externalSelection);
  assert.deepEqual(new Set(model.getSelectedPaths()), new Set(["a-last.md", "empty folder/"]));
  assert.deepEqual(visiblePaths(model), ["z-source/", "empty folder/", "a-last.md"]);
});

test("restoring a hidden expanded descendant keeps its parent collapsed", async (t) => {
  const { input, model, preparePresortedFileTreeInput } = await createModel();
  t.after(() => model.cleanUp());
  const parent = model.getItem("z-source");
  const child = model.getItem("z-source/nested");
  assert.ok(parent && "expand" in parent && child && "expand" in child);
  parent.expand();
  child.expand();
  parent.collapse();
  const expandedPaths = getExpandedTreePaths(model, input.directoryPaths);
  assert.deepEqual(expandedPaths, ["z-source/nested/"]);
  model.resetPaths({ preparedInput: preparePresortedFileTreeInput(input.paths), initialExpandedPaths: expandedPaths });
  restoreTreeExpansion(model, input.directoryPaths, expandedPaths);
  assert.deepEqual(visiblePaths(model), ["z-source/", "empty folder/", "a-last.md"]);
  parent.expand();
  assert.ok(visiblePaths(model).includes("z-source/nested/计划.ts"));
});
