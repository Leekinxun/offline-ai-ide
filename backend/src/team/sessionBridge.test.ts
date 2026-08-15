import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveTeamStoreRoot } from "./sessionBridge.js";

test("team store root honors the configured persistent deployment directory", () => {
  assert.equal(resolveTeamStoreRoot("/app", " /app/config "), path.resolve("/app/config"));
});

test("team store root preserves the local development defaults", () => {
  const repositoryRoot = path.resolve("session-bridge-fixture");
  assert.equal(resolveTeamStoreRoot(path.join(repositoryRoot, "backend")), repositoryRoot);
  assert.equal(resolveTeamStoreRoot(repositoryRoot, "  "), repositoryRoot);
});
