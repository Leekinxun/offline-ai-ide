import assert from "node:assert/strict";
import test from "node:test";
import { LoginLimiter } from "./loginLimiter.js";

test("login limiter bounds concurrent KDFs and backs off repeated source/account failures", () => {
  let now = 10_000;
  const limiter = new LoginLimiter(() => now, 2);
  const first = limiter.start("192.0.2.1", "Alice");
  const second = limiter.start("192.0.2.1", "Bob");
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.deepEqual(limiter.start("192.0.2.2", "Charlie"), { allowed: false, retryAfterSeconds: 1 });
  if (!first.allowed || !second.allowed) throw new Error("Expected permits");
  first.finish(false);
  second.finish(true);

  for (let attempt = 1; attempt < 5; attempt += 1) {
    const permit = limiter.start("192.0.2.1", "alice");
    assert.equal(permit.allowed, true);
    if (!permit.allowed) throw new Error("Expected permit");
    permit.finish(false);
  }
  assert.deepEqual(limiter.start("192.0.2.1", "ALICE"), { allowed: false, retryAfterSeconds: 1 });
  const independent = limiter.start("192.0.2.2", "alice");
  assert.equal(independent.allowed, true);
  if (independent.allowed) independent.finish(true);
  now += 1_000;
  const retry = limiter.start("192.0.2.1", "alice");
  assert.equal(retry.allowed, true);
  if (!retry.allowed) throw new Error("Expected retry permit");
  retry.finish(false);
  assert.deepEqual(limiter.start("192.0.2.1", "alice"), { allowed: false, retryAfterSeconds: 2 });
});
