import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PolicyAuditLog } from "./policyAudit.js";

test("policy audit is append-only, redacted, and detects chain tampering", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "policy-audit-"));
  const file = path.join(directory, "audit.jsonl");
  try {
    const audit = new PolicyAuditLog(file);
    audit.append({ runId: "run", workspace: "workspace", requestId: "r1", toolCallId: "c1", toolName: "read", allowed: true, input: { apiKey: "secret" } });
    audit.append({ runId: "run", workspace: "workspace", requestId: "r2", toolCallId: "c2", toolName: "write", allowed: false, reason: "denied", input: {} });
    assert.deepEqual(audit.verify(), { valid: true, entries: 2 });
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /"secret"/);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, `${lines[0].replace('"allowed":true', '"allowed":false')}\n${lines[1]}\n`);
    assert.equal(audit.verify().valid, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
