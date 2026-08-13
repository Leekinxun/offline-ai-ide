import assert from "node:assert/strict";
import test from "node:test";
import { evaluateNetworkAccess, normalizeNetworkGrant, normalizeNetworkHost } from "./networkPolicy.js";

test("network policy denies by default and grants only an exact normalized host and port", () => {
  const grants = [{ host: "API.Example.test.", port: 443 }];
  const allowed = evaluateNetworkAccess("api.example.test", 443, grants);
  assert.deepEqual(allowed, { allowed: true, grant: { host: "api.example.test", port: 443 } });
  assert.equal(evaluateNetworkAccess("api.example.test", 80, grants).allowed, false);
  assert.equal(evaluateNetworkAccess("other.example.test", 443, grants).allowed, false);
});

test("network policy rejects wildcard and public-bypass destinations", () => {
  for (const host of ["*.example.test", "0.0.0.0", "::", "https://example.test", "example.test/path"]) {
    assert.equal(normalizeNetworkHost(host), undefined, host);
  }
  assert.equal(normalizeNetworkGrant({ host: "*", port: 443 }), undefined);
  assert.equal(evaluateNetworkAccess("0.0.0.0", 443, [{ host: "0.0.0.0", port: 443 }]).allowed, false);
});
