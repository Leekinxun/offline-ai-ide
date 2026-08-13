import assert from "node:assert/strict";
import test from "node:test";
import { REDACTED, redactSecrets } from "./secretRedaction.js";

test("redactSecrets recursively redacts named secrets and credential fixtures", () => {
  const source = {
    token: "abc123",
    nested: [{ password: "hunter2" }, { value: "Bearer abcdefghijklmnop" }],
    pem: "-----BEGIN PRIVATE KEY-----\nprivate",
    ordinary: "safe",
  };
  const redacted = redactSecrets(source);
  assert.notEqual(redacted, source);
  assert.equal(redacted.token, REDACTED);
  assert.equal(redacted.nested[0].password, REDACTED);
  assert.equal(redacted.nested[1].value, `Bearer ${REDACTED}`);
  assert.equal(redacted.pem, REDACTED);
  assert.equal(redacted.ordinary, "safe");
  assert.equal(source.token, "abc123");
});

test("redactSecrets replaces secret substrings while retaining harmless context", () => {
  const canary = "sk-test_CANARY_SECRET_123456";
  const source = {
    text: `keep this ${canary} and this code()`,
    bearerText: `Bearer ${canary}`,
    endpoint: `https://alice:${canary}@provider.test/path?api_key=${canary}&page=2`,
    env: `MODE=test\nAPI_KEY=${canary}\nSAFE=true`,
    pem: "before -----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY----- after",
    safe: "const harmlessCode = true;",
  };

  const redacted = redactSecrets(source);
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, new RegExp(canary));
  assert.match(redacted.text, /keep this \[REDACTED\] and this code\(\)/);
  assert.match(redacted.bearerText, /^Bearer \[REDACTED\]$/);
  assert.match(redacted.endpoint, /provider\.test\/path\?api_key=\[REDACTED\]&page=2/);
  assert.match(redacted.env, /MODE=test/);
  assert.match(redacted.env, /SAFE=true/);
  assert.equal(redacted.pem, `before ${REDACTED} after`);
  assert.equal(redacted.safe, source.safe);
});
