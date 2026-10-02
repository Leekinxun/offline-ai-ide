import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROCESS_TIMEOUT_MINUTES,
  MAX_PROCESS_TIMEOUT_MINUTES,
  MIN_PROCESS_TIMEOUT_MINUTES,
  canStartProcessSession,
  getProcessSessionTiming,
  normalizeProcessTimeoutMinutes,
} from "../src/components/processSessionPolicy.ts";

test("normalizes only integer minute timeouts from 1 to 1440", () => {
  assert.deepEqual(normalizeProcessTimeoutMinutes(1), { minutes: 1, timeoutMs: 60_000, valid: true });
  assert.deepEqual(normalizeProcessTimeoutMinutes("1440"), { minutes: 1440, timeoutMs: 86_400_000, valid: true });
  assert.deepEqual(normalizeProcessTimeoutMinutes(MIN_PROCESS_TIMEOUT_MINUTES).valid, true);
  assert.deepEqual(normalizeProcessTimeoutMinutes(MAX_PROCESS_TIMEOUT_MINUTES).valid, true);

  for (const value of [0, 1441, 1.5, "1.5", "abc", "", undefined, null, -1]) {
    assert.deepEqual(normalizeProcessTimeoutMinutes(value), {
      minutes: DEFAULT_PROCESS_TIMEOUT_MINUTES,
      timeoutMs: DEFAULT_PROCESS_TIMEOUT_MINUTES * 60_000,
      valid: false,
    });
  }
});

test("computes recorded deadlines without inventing unknown remaining time or negative values", () => {
  assert.deepEqual(getProcessSessionTiming({ status: "running" }, 1_000), { hasRecordedDeadline: false, expired: false });
  assert.deepEqual(getProcessSessionTiming({ status: "running", deadlineAt: null, timeoutMs: null }, 1_000), { hasRecordedDeadline: false, expired: false });

  assert.deepEqual(getProcessSessionTiming({ status: "running", timeoutMs: 600_000, deadlineAt: 65_000 }, 5_000), {
    hasRecordedDeadline: true,
    timeoutMs: 600_000,
    deadlineAt: 65_000,
    remainingMs: 60_000,
    expired: false,
  });
  assert.deepEqual(getProcessSessionTiming({ status: "running", timeoutMs: 600_000, deadlineAt: 5_000 }, 6_000), {
    hasRecordedDeadline: true,
    timeoutMs: 600_000,
    deadlineAt: 5_000,
    remainingMs: 0,
    expired: true,
  });
  assert.equal(getProcessSessionTiming({ status: "exited", deadlineAt: 5_000 }, 6_000).expired, false);
});

test("start policy blocks readonly, busy, invalid timeout, missing task, and stale scope", () => {
  const base = {
    readOnly: false,
    busy: false,
    hasTask: true,
    timeoutMinutes: "10",
    currentScope: "workspace\0token",
    expectedScope: "workspace\0token",
  };
  assert.equal(canStartProcessSession(base), true);
  assert.equal(canStartProcessSession({ ...base, readOnly: true }), false);
  assert.equal(canStartProcessSession({ ...base, busy: true }), false);
  assert.equal(canStartProcessSession({ ...base, hasTask: false }), false);
  assert.equal(canStartProcessSession({ ...base, timeoutMinutes: "1441" }), false);
  assert.equal(canStartProcessSession({ ...base, expectedScope: "other\0token" }), false);
  assert.equal(canStartProcessSession({ ...base, expectedScope: null }), false);
});
