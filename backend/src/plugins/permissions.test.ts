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

test("rejects path-qualified, symlink-like, and wildcard network grants", () => {
  for (const grant of [
    "editor.modify:../../outside",
    "editor.modify:linked/secret.txt",
    "network:*",
    "network.connect:*.example.test",
  ]) {
    const parsed = parsePluginPermissions([grant]);
    assert.deepEqual(parsed.permissions, []);
    assert.match(parsed.error || "", /Unknown permission/);
  }
});
