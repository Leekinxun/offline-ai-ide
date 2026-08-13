import assert from "node:assert/strict";
import test from "node:test";
import { terminalEnvironment } from "./terminal.js";

test("terminal launcher environment excludes ambient secrets and injection variables", () => {
  const keys = ["CREWFORGE_TERMINAL_SECRET", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "BASH_ENV"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "must-not-leak";
    const env = terminalEnvironment();
    for (const key of keys) assert.equal(env[key], undefined);
    assert.equal(env.TERM, "xterm-256color");
    assert.ok(env.PATH);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
