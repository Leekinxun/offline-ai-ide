import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { probeNetworkIsolation } from "./processSandbox.js";
import { runWorkspaceCommand } from "./shell.js";

const networkCapability = probeNetworkIsolation();
const networkHelperSkip = networkCapability.available
  ? false
  : `hard network isolation unavailable: ${networkCapability.reason}`;

test("runs a policy-permitted compatibility shell command asynchronously", { skip: networkHelperSkip }, async () => {
  const output = await runWorkspaceCommand("printf ok", process.cwd());
  assert.equal(output, "ok");
});

test("aborts an in-flight shell command", { skip: networkHelperSkip }, async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = runWorkspaceCommand("sleep 10", process.cwd(), controller.signal);
  setTimeout(() => controller.abort(), 50);
  assert.match(await pending, /stopped/i);
  assert.ok(Date.now() - startedAt < 2000);
});

test("fails closed on shell syntax unless compatibility execution is explicitly authorized", async () => {
  const output = await runWorkspaceCommand("printf 'a' | wc -c", process.cwd());
  assert.match(output, /shell syntax requires explicit compatibility-shell authorization/i);
});

test("authorized compatibility execution still applies destructive-command policy", { skip: networkHelperSkip }, async () => {
  const options = { compatibilityShellAuthorized: true };
  const output = await runWorkspaceCommand("printf 'a' | wc -c", process.cwd(), undefined, options);
  assert.equal(output, "1");

  for (const command of ["sudo printf ok", "rm harmless", "cat ../outside", "node -e 'process.stdout.write(1)'"]) {
    const blocked = await runWorkspaceCommand(command, process.cwd(), undefined, options);
    assert.match(blocked, /^Error: Command blocked by workspace policy:/, command);
  }
});

test("compatibility shell applies CPU and open-file hard limits before the approved command", { skip: process.platform === "win32" ? "POSIX ulimit is unavailable on Windows" : networkHelperSkip }, async () => {
  const output = await runWorkspaceCommand(
    "ulimit -H -t; ulimit -H -n",
    process.cwd(),
    undefined,
    {
      compatibilityShellAuthorized: true,
      resourceLimits: { cpuTimeMs: 2_000, maxOpenFiles: 64, memoryBytes: undefined },
    }
  );
  const [cpuSeconds, openFiles] = output.split(/\s+/).map(Number);
  assert.ok(cpuSeconds <= 2, output);
  assert.ok(openFiles <= 64, output);
});

test("agent shell keeps local filesystem reads available under hard network deny", { skip: networkHelperSkip }, async () => {
  const output = await runWorkspaceCommand("wc -c package.json", process.cwd());
  assert.match(output, /^\d+\s+package\.json$/);
});

test("approved script cannot connect to a loopback socket", { skip: networkHelperSkip }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-network-test-"));
  const scriptPath = path.join(directory, "connect.cjs");
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    fs.writeFileSync(scriptPath, `
      const net = require("net");
      const socket = net.connect({ host: "127.0.0.1", port: Number(process.argv[2]) });
      socket.once("connect", () => { process.stdout.write("CONNECTED"); socket.destroy(); });
      socket.once("error", () => process.stdout.write("DENIED"));
      setTimeout(() => { process.stdout.write("TIMEOUT"); socket.destroy(); }, 1000).unref();
    `);
    const output = await runWorkspaceCommand(
      `node ${JSON.stringify(scriptPath)} ${address.port}`,
      directory
    );
    assert.equal(output, "DENIED");
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
