import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./windows-native-sandbox-smoke.mjs", import.meta.url), "utf8");
const start = source.indexOf('  await step("session timeout reaps the complete payload subtree", async () => {');
const end = source.indexOf('  await step("a real backend crash leaves no sandbox payload descendants"', start);
assert.ok(start >= 0 && end > start);
// Exercise the actual bounded fixture block without evaluating the Windows-only
// smoke entry point or reading any backend/user configuration.
const timeoutStep = source.slice(start, end);

async function exercise(t, mode = "normal") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-timeout-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 100_000; const startedAt = now; const pids = [2345, 2346, 2347];
  let input; let result; let stoppedCheck = false;
  const checks = [];
  const fixtureId = "owned";
  const publish = () => {
    ["parent", "child", "grandchild"].forEach((role, i) => fs.writeFileSync(path.join(directory, "timeout-owned-" + role + ".pid"), String(pids[i])));
    ["child", "grandchild"].forEach((role) => fs.writeFileSync(path.join(directory, "timeout-owned-" + role + ".heartbeat"), "1"));
  };
  const summary = () => ({
    id: "fixture-session", startedAt, deadlineAt: startedAt + input.timeoutMs,
    status: mode === "early" && now >= startedAt + 1000 ? "timed_out" :
      now >= startedAt + input.timeoutMs ? mode === "wrong-status" ? "exited" : "timed_out" : "running",
    endedAt: now >= startedAt + input.timeoutMs ? startedAt + input.timeoutMs : undefined,
  });
  const context = vm.createContext({
    assert, fs, path, process, fixtureId, checks, heartbeatDir: directory, workspace: directory,
    owner: {}, filesystem: {}, powershell: "owned-powershell",
    Date: { now: () => now }, Set,
    psLiteral: (value) => "'" + value + "'", psArgs: (value) => ["-Command", value],
    text: (poll) => poll.events.map((entry) => entry.text).join(""),
    pidAlive: () => now < startedAt + input.timeoutMs,
    rememberSupervisors: () => {},
    sessions: {
      startAgentProcessSession(value) { input = value; return summary(); },
      pollProcessSession() {
        return { session: summary(), events: mode === "early" ? [] : [{ text: "TIMEOUT-FIXTURE-ROOT:" + pids[0] }] };
      },
      stopProcessSession() { assert.fail("A real timeout fixture must not explicitly stop its canaries"); },
    },
    async until(predicate, label, budget) {
      const limit = now + budget;
      while (now <= limit) {
        if (mode !== "early" && now >= startedAt + 22_000 && !fs.existsSync(path.join(directory, "timeout-owned-parent.pid"))) publish();
        const value = await predicate(); if (value) return value;
        now += 1000;
      }
      throw new Error("Fixture evidence deadline: " + label);
    },
    async assertSubtreeStopped(evidence) {
      assert.equal(summary().status, "timed_out");
      assert.ok(now >= startedAt + input.timeoutMs);
      assert.deepEqual([...evidence.pids], pids, "Cleanup requires all actually observed payload roles");
      stoppedCheck = true;
      return { allPidsExited: true };
    },
    async step(name, action) { result = await action(); },
  });
  let error;
  try { await vm.runInContext("(async () => {\n" + timeoutStep + "\n})()", context); } catch (caught) { error = caught; }
  return { input, result, error, stoppedCheck, checks };
}

test("the timeout fixture observes live startup then waits for its real wall deadline before subtree proof", async (t) => {
  const value = await exercise(t);
  assert.equal(value.error, undefined);
  assert.equal(value.input.timeoutMs, 60_000);
  assert.match(value.input.args[1], /Console\]::WriteLine/);
  assert.equal(value.result.status, "timed_out");
  assert.equal(value.result.startupBudgetMs, 45_000);
  assert.equal(value.result.startupElapsedMs, 22_000);
  assert.equal(value.result.elapsedMs, 60_000);
  assert.equal(value.result.stdoutRootMarker, 2345);
  assert.equal(value.result.observedPids.length, 3);
  assert.equal(value.result.rolePidFiles.length, 3);
  assert.equal(value.stoppedCheck, true);
});

test("an unstarted or prematurely expired payload cannot pass and retains each role's PID diagnostics", async (t) => {
  const value = await exercise(t, "early");
  assert.ok(value.error);
  assert.equal(value.stoppedCheck, false);
  assert.equal(value.checks[0].status, "INFO");
  assert.equal(value.checks[0].sessionStatus, "timed_out");
  assert.equal(value.checks[0].stdoutRootMarker, null);
  assert.equal(value.checks[0].observedPids.length, 0);
  assert.equal(value.checks[0].rolePidFiles.length, 3);
  assert.ok(value.checks[0].rolePidFiles.every((entry) => entry.exists === false));
});

test("normal exit at the deadline is not a timed-out cleanup pass", async (t) => {
  const value = await exercise(t, "wrong-status");
  assert.ok(value.error);
  assert.equal(value.stoppedCheck, false);
  assert.equal(value.checks[0].sessionStatus, "exited");
});
