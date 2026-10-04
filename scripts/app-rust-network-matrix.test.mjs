import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { classifyNetworkProbe, fixtureReceiver, hostProbe, parseProbeOutput, probeSource } from "./app-rust-network-matrix.mjs";

const record = (changes = {}) => ({
  completed: true, pid: 2345, sid: "S-1-5-21-123-456-789-1001", sent: false, ack: false,
  socketError: 10013, privateReadable: null, writeAllowed: null, ...changes,
});
const output = (value) => "CROWNFORGE_NETWORK_MATRIX:" + JSON.stringify(value) + "\n";

test("launch errors, exit failures, missing completion and malformed evidence never count as denial", () => {
  for (const result of [
    "Error: Timeout after 90000ms\n" + output(record()),
    "Error: Process exited with code 23\n" + output(record()),
    "Error: Stopped\n", "Error: launch failed\n", "unrelated output\n",
    output(record()) + output(record()), output(record({ pid: null })),
    output(record({ sid: "invalid" })), output(record({ socketError: "10013" })),
  ]) assert.equal(classifyNetworkProbe(parseProbeOutput(result), 0, "deny"), "EXECUTION_ERROR");
});

test("receiver-confirmed nonce delivery overrides a reported socket rejection", () => {
  const rejection = parseProbeOutput(output(record()));
  assert.equal(classifyNetworkProbe(rejection, 0, "deny"), "DENIED");
  assert.equal(classifyNetworkProbe(rejection, 1, "deny"), "NETWORK_LEAK");
  assert.equal(classifyNetworkProbe(rejection, 0, "deny", 1), "NETWORK_LEAK", "An accepted TCP handshake is already a loopback leak");
  assert.equal(classifyNetworkProbe(parseProbeOutput(output(record({ ack: true }))), 0, "deny"), "NETWORK_LEAK");
  assert.equal(classifyNetworkProbe(parseProbeOutput(output(record({ socketError: null }))), 0, "deny"), "UNCONFIRMED");
});

test("inherit requires successful payload execution, receiver delivery and an acknowledgement", () => {
  const connected = parseProbeOutput(output(record({ sent: true, ack: true, socketError: null })));
  assert.equal(classifyNetworkProbe(connected, 1, "inherit"), "CONNECTED");
  assert.equal(classifyNetworkProbe(connected, 0, "inherit"), "CONNECT_FAILED");
  assert.equal(classifyNetworkProbe(connected, 2, "inherit"), "CONNECT_FAILED");
  assert.equal(classifyNetworkProbe({ ...connected, errorKind: "timeout" }, 1, "inherit"), "EXECUTION_ERROR");
});

test("PowerShell probes use fixed .NET socket operations and Console, with bounded socket timeouts", () => {
  for (const host of ["127.0.0.1", "::1"]) for (const protocol of ["tcp", "udp"]) {
    const source = probeSource({ protocol, host, port: 12345 }, "a".repeat(64), "C:\\fixture\\.env", "C:\\fixture\\must-not-exist");
    assert.match(source, /\[Console\]::WriteLine/);
    assert.match(source, /WindowsIdentity\]::GetCurrent/);
    assert.match(source, /3000/);
    assert.match(source, /UnauthorizedAccessException/);
    assert.doesNotMatch(source, /Write-Output|ConvertTo-Json|Get-Content|Set-Content|New-Object/);
  }
  assert.throws(() => probeSource({ protocol: "tcp", host: "example.org", port: 12345 }, "a".repeat(64)));
  assert.throws(() => probeSource({ protocol: "tcp", host: "127.0.0.1", port: 70000 }, "a".repeat(64)));
  assert.throws(() => probeSource({ protocol: "tcp", host: "127.0.0.1", port: 12345 }, "untrusted'; command"));
});

for (const host of ["127.0.0.1", "::1"]) for (const protocol of ["tcp", "udp"]) {
  test("live fixture receives unique " + protocol + " " + host + " nonce and acknowledges it", { timeout: 12000 }, async () => {
    // This proves the measurement fixture, not native Windows sandbox isolation.
    const receiver = await fixtureReceiver(protocol, host);
    try {
      const first = crypto.randomBytes(32).toString("hex");
      assert.equal(await hostProbe(receiver, first), true);
      assert.equal(receiver.count(first), 1);
      const unseen = crypto.randomBytes(32).toString("hex"); receiver.expect(unseen);
      assert.equal(receiver.count(unseen), 0);
      const second = crypto.randomBytes(32).toString("hex");
      assert.equal(await hostProbe(receiver, second), true);
      assert.equal(receiver.count(first), 1);
      assert.equal(receiver.count(second), 1);
    } finally { await receiver.close(); }
  });
}
