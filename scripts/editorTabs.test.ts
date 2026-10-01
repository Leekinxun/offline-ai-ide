import assert from "node:assert/strict";
import test from "node:test";
import { getTabPathLabels, isSameTabPath, normalizeTabPath, uniqueTabFiles } from "../frontend/src/components/tabBarModel.js";

const tab = (path: string) => ({
  path,
  name: path.replace(/\\/g, "/").split("/").pop() || path,
});

test("tab identity normalizes separators while preserving case", () => {
  assert.equal(normalizeTabPath("./src\\Foo.ts"), "src/Foo.ts");
  assert.equal(isSameTabPath("src\\Foo.ts", "./src/Foo.ts"), true);
  assert.equal(isSameTabPath("src/Foo.ts", "src/foo.ts"), false);
});

test("open tab de-duplication keeps Linux case-distinct files separate", () => {
  const files = [tab("src/Foo.ts"), tab("src/foo.ts"), tab("src\\Foo.ts")];
  const unique = uniqueTabFiles(files);
  assert.deepEqual(unique.map((file) => file.path), ["src/Foo.ts", "src/foo.ts"]);
});

test("path labels disambiguate same-name tabs after separator normalization", () => {
  const files = uniqueTabFiles([
    tab("src/components/index.ts"),
    tab("src\\hooks\\index.ts"),
    tab("src/components/Button.tsx"),
  ]);
  const labels = getTabPathLabels(files);
  assert.equal(labels.get("src/components/index.ts"), "components");
  assert.equal(labels.get("src\\hooks\\index.ts"), "hooks");
  assert.equal(labels.has("src/components/Button.tsx"), false);
});
