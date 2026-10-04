import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { runDiagnostics } from "../diagnostics/service.js";

function fixture(t: test.TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-offline-diagnostics-")));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, "Cargo.toml"), '[package]\nname = "disposable-fixture"\nversion = "0.0.0"\n');
  const keys = ["PATH", "CREWFORGE_DESKTOP", "CROWNFORGE_IDE_CORE_EXECUTABLE", "RUSTUP_AUTO_INSTALL", "CARGO_HOME"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PATH = bin;
  process.env.CREWFORGE_DESKTOP = "1";
  process.env.RUSTUP_AUTO_INSTALL = "1";
  // This check does not start a watcher or make a native RPC request.
  process.env.CROWNFORGE_IDE_CORE_EXECUTABLE = path.join(bin, "unused-ide-core");
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, bin };
}

test("desktop Cargo diagnostics stay offline and report unavailable cached dependencies while Web keeps its command", {
  skip: process.platform === "win32" ? "Executable fixture script requires a Unix host; this is a desktop/Web selection regression" : false,
}, async (t) => {
  const { root, bin } = fixture(t);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const argsFile = path.join(root, "cargo-args.json");
  fs.writeFileSync(path.join(bin, "cargo"), `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), autoInstall: process.env.RUSTUP_AUTO_INSTALL }));
process.stderr.write("no matching package named fixture-dependency found in the offline cache");
process.exitCode = 101;
`, { mode: 0o755 });

  const desktop = await runDiagnostics(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), { args: ["check", "--offline", "--message-format=json"], autoInstall: "0" });
  assert.equal(desktop.diagnostics.length, 1);
  assert.equal(desktop.diagnostics[0].path, "Cargo.toml");
  assert.equal(desktop.diagnostics[0].severity, "error");
  assert.match(desktop.diagnostics[0].message, /offline mode.*\nno matching package/s);

  process.env.CREWFORGE_DESKTOP = "0";
  const web = await runDiagnostics(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), { args: ["check", "--message-format=json"], autoInstall: "1" });
  assert.deepEqual(web.diagnostics, []);
});

test("desktop Cargo diagnostics report a missing toolchain without downloading it", async (t) => {
  const { root } = fixture(t);
  const result = await runDiagnostics(root);
  assert.deepEqual(result.tools, []);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /Cargo is not installed.*offline diagnostics/);
});

test("real desktop Cargo reports an uncached dependency without contacting a reachable registry", { timeout: 15_000 }, async (t) => {
  const probe = spawnSync("cargo", ["--version"], { env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" }, encoding: "utf8", timeout: 5_000 });
  if (probe.error || probe.status !== 0) { t.skip("A preinstalled Rust toolchain is required for the real Cargo check"); return; }
  const availablePath = process.env.PATH;
  const { root } = fixture(t);
  process.env.PATH = availablePath;
  process.env.CARGO_HOME = path.join(root, "empty-cargo-home");
  fs.mkdirSync(process.env.CARGO_HOME);
  fs.mkdirSync(path.join(root, ".cargo"));
  fs.writeFileSync(path.join(root, "lib.rs"), "pub fn fixture() {}\n");
  fs.appendFileSync(path.join(root, "Cargo.toml"), '[lib]\npath = "lib.rs"\n[dependencies]\ncrownforge_offline_fixture = "=0.0.1"\n');

  let requests = 0;
  const registry = http.createServer((request, response) => {
    requests += 1;
    if (request.url === "/config.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ dl: "http://127.0.0.1:9/unavailable" }));
    } else { response.writeHead(404); response.end("disposable registry fixture"); }
  });
  await new Promise<void>((resolve, reject) => {
    registry.once("error", reject);
    registry.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve())));
  const address = registry.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/`;
  const control = await fetch(url);
  assert.equal(control.status, 404);
  assert.equal(requests, 1);
  requests = 0;
  fs.writeFileSync(path.join(root, ".cargo", "config.toml"), `[source.crates-io]\nreplace-with = "disposable-local-registry"\n[source.disposable-local-registry]\nregistry = "sparse+${url}"\n[http]\nproxy = ""\n[net]\nretry = 0\n`);

  const result = await runDiagnostics(root);
  assert.equal(requests, 0);
  assert.deepEqual(result.tools, ["cargo"]);
  assert.ok(result.diagnostics.some((finding) => finding.severity === "error" && /offline mode/.test(finding.message)));
  assert.ok(result.diagnostics.some((finding) => /crownforge_offline_fixture/.test(finding.message)));
});
