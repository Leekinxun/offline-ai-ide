import assert from "node:assert/strict";
import test from "node:test";
import { derivePluginScopes, parsePluginPermissions } from "./permissions.js";

test("accepts editor.modify as an explicit editor capability", () => {
  const parsed = parsePluginPermissions(["editor.preview", "editor.modify"]);
  assert.deepEqual(parsed, {
    permissions: ["editor.preview", "editor.modify"],
  });
  assert.deepEqual(derivePluginScopes(parsed.permissions), ["editor"]);
});
