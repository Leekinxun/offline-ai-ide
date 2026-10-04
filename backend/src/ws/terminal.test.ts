import assert from "node:assert/strict";
import test from "node:test";
import { terminalEnvironment, terminalShell } from "./terminal.js";

test("terminal launcher environment excludes ambient secrets and injection variables", () => {
  const keys = ["CREWFORGE_TERMINAL_SECRET", "CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "BASH_ENV"];
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

test("Windows terminal selects cmd.exe and retains only required host environment", () => {
  const keys = ["ComSpec", "SHELL", "SystemRoot", "PATHEXT", "APPDATA", "NODE_OPTIONS"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    process.env.SHELL = "/bin/zsh";
    process.env.SystemRoot = "C:\\Windows";
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    process.env.NODE_OPTIONS = "--require malicious.js";

    assert.deepEqual(terminalShell("win32"), {
      executable: "C:\\Windows\\System32\\cmd.exe",
      ptyArgs: ["/d"],
      fallbackArgs: ["/d"],
    });
    const env = terminalEnvironment("win32");
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
    assert.equal(env.APPDATA, "C:\\Users\\test\\AppData\\Roaming");
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.ok(env.PATH);
    assert.equal(terminalEnvironment("darwin").ComSpec, undefined);

    delete process.env.ComSpec;
    assert.equal(terminalShell("win32").executable, "cmd.exe");
    assert.deepEqual(terminalShell("darwin").ptyArgs, ["--login"]);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Rust desktop preserves the user's zsh configuration directory without changing Web inheritance", () => {
  const keys = ["CREWFORGE_DESKTOP", "CROWNFORGE_IDE_CORE_EXECUTABLE", "ZDOTDIR"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.ZDOTDIR = "/fixture/custom-zsh-config";
    process.env.CREWFORGE_DESKTOP = "1";
    process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = "/fixture/core";
    assert.equal(terminalEnvironment("darwin").ZDOTDIR, process.env.ZDOTDIR);
    assert.equal(terminalEnvironment("win32").ZDOTDIR, undefined);
    process.env.CREWFORGE_DESKTOP = "0";
    assert.equal(terminalEnvironment("darwin").ZDOTDIR, undefined);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
