import assert from "node:assert/strict";
import test from "node:test";
import {
  addJsonChild,
  deleteJsonNode,
  formatJson,
  renameJsonKey,
  replaceJsonNode,
  type JsonValue,
} from "../frontend/src/plugins/builtin/jsonTree.ts";

const fixture: JsonValue = {
  profile: { name: "Ada", active: true },
  tags: ["compiler"],
};

test("replaces primitive values without mutating the source document", () => {
  const next = replaceJsonNode(fixture, ["profile", "active"], false);
  assert.deepEqual(next, {
    profile: { name: "Ada", active: false },
    tags: ["compiler"],
  });
  assert.equal((fixture.profile as Record<string, JsonValue>).active, true);
});

test("adds object properties and array items", () => {
  const withRole = addJsonChild(fixture, ["profile"], "role", "engineer");
  const withTag = addJsonChild(withRole, ["tags"], undefined, "json");
  assert.deepEqual(withTag, {
    profile: { name: "Ada", active: true, role: "engineer" },
    tags: ["compiler", "json"],
  });
});

test("renames object keys in place and rejects duplicate keys", () => {
  const next = renameJsonKey(fixture, ["profile", "name"], "displayName");
  assert.deepEqual(next, {
    profile: { displayName: "Ada", active: true },
    tags: ["compiler"],
  });
  assert.throws(
    () => renameJsonKey(fixture, ["profile", "name"], "active"),
    /already exists/
  );
});

test("deletes object properties and compacts array indexes", () => {
  const withoutActive = deleteJsonNode(fixture, ["profile", "active"]);
  const withoutTag = deleteJsonNode(withoutActive, ["tags", 0]);
  assert.deepEqual(withoutTag, { profile: { name: "Ada" }, tags: [] });
  assert.throws(() => deleteJsonNode(fixture, []), /root node cannot be deleted/i);
});

test("formats mutations as stable editor content", () => {
  assert.equal(formatJson({ ok: true }), '{\n  "ok": true\n}\n');
});
