import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyNetworkProbe, fixtureReceiver, hostProbe, matchingOfficialIdentities, officialBaselineConfiguration, officialDiagnostic,
  officialProbeArguments, parseProbeOutput, probeSource, writeOfficialProbeScript,
} from "./app-rust-network-matrix.mjs";

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

test("a missing receiver and two missing identity receipts never pass a control", () => {
  assert.equal(classifyNetworkProbe(parseProbeOutput(output(record())), 0, "deny", 0, false), "INVALID_RECEIVER");
  for (const sidHash of [null, undefined, ""]) assert.equal(matchingOfficialIdentities({ sidHash }, { sidHash }), false);
  assert.equal(matchingOfficialIdentities({ sidHash: "a".repeat(64) }, { sidHash: null }), false);
  assert.equal(matchingOfficialIdentities({ sidHash: "a".repeat(64) }, { sidHash: "b".repeat(64) }), false);
  assert.equal(matchingOfficialIdentities({ sidHash: "a".repeat(64) }, { sidHash: "a".repeat(64) }), true);
});

test("official PowerShell receives the identical BOM script, not literal JSON in a command argument", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-official-script-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = probeSource({ protocol: "tcp", host: "127.0.0.1", port: 12345 }, "a".repeat(64)) +
    "\n# quoted UTF-8 fixture: '中文' \"double quotes\"\n";
  const first = writeOfficialProbeScript(workspace, source);
  const second = writeOfficialProbeScript(workspace, source);
  assert.notEqual(first, second, "Before and after probes need independently owned files");
  for (const script of [first, second]) {
    assert.equal(path.dirname(script), workspace, "The original sandbox's read grant must cover the script");
    const bytes = fs.readFileSync(script);
    assert.deepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    assert.equal(bytes.subarray(3).toString("utf8"), source, "Probe source must not be escaped or rewritten");
    const args = officialProbeArguments(workspace, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", script);
    assert.deepEqual(args.slice(-2), ["-File", script]);
    assert.equal(args[args.indexOf("sandbox") + 1], "-P", "The CLI chooses the Windows implementation itself");
    assert.equal(args[args.indexOf("-P") + 1], "matrix");
    assert.equal(args.includes("-Command"), false);
    assert.equal(args.includes(source), false);
  }
});

test("official diagnostics retain only fixed actions and numeric Windows errors, including logon password failures", () => {
  const root = "C:\\Users\\fixture-owner\\Temp\\matrix";
  const secret = "private-fixture-credential";
  const diagnostic = officialDiagnostic([
    "Error: CreateProcessWithLogonW failed: 1326; password=" + secret,
    "At " + root.toUpperCase() + "\\workspace\\probe.ps1:24 char:12",
    "+ [Console]::WriteLine('CROWNFORGE_NETWORK_MATRIX:' + $bytes)",
    "+ CategoryInfo : ParserError: (:) [], ParseException",
    "+ FullyQualifiedErrorId : UnexpectedToken",
    "Error: TOKEN=" + secret,
    "Error: PASSWORD=" + secret,
    "Error: Authorization: Bearer " + secret,
    "Error: argv=['-Command', 'private source']",
  ].join("\n"), root, true);
  assert.equal(diagnostic.category, "powershell_parse");
  assert.equal(diagnostic.action, "CreateProcessWithLogonW");
  assert.deepEqual(diagnostic.windowsErrorCodes, [1326]);
  assert.equal(diagnostic.truncated, true);
  assert.deepEqual(Object.keys(diagnostic).sort(), ["action", "category", "truncated", "windowsErrorCodes"]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-owner|C:\\Users|private-fixture-credential|Console|argv|-Command/);
  assert.deepEqual(officialDiagnostic("LogonUserW failed: 1385 (Windows error 1385)\nOS error 5", root).windowsErrorCodes, [1385, 5]);
  assert.deepEqual(officialDiagnostic("Error: password=1326; token=123456789", root).windowsErrorCodes, []);
  assert.equal(officialDiagnostic("Error: LogonUserW failed: 1326", root).action, "LogonUserW");
  for (const [input, category] of [
    ["Error: unknown permission profile", "configuration"],
    ["Error: LogonUser failed", "sandbox_identity"],
    ["Error: access is denied", "access"],
    ["Error: CreateProcess failed", "launch"],
  ]) assert.equal(officialDiagnostic(input, root).category, category);
});

test("official setup and controls share an Online profile without model or auth requirements", () => {
  const config = officialBaselineConfiguration();
  assert.match(config, /\[permissions\.matrix\.network\]\nenabled = true\n$/);
  assert.match(config, /requires_openai_auth = false/);
  assert.match(config, /check_for_update_on_startup = false/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:9"/);
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
      assert.equal(receiver.isActive(), true);
      assert.equal(await hostProbe(receiver, first), true);
      assert.equal(receiver.count(first), 1);
      const unseen = crypto.randomBytes(32).toString("hex"); receiver.expect(unseen);
      assert.equal(receiver.count(unseen), 0);
      const second = crypto.randomBytes(32).toString("hex");
      assert.equal(await hostProbe(receiver, second), true);
      assert.equal(receiver.count(first), 1);
      assert.equal(receiver.count(second), 1);
    } finally { await receiver.close(); }
    assert.equal(receiver.isActive(), false);
  });
}
