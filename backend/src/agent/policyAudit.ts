import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./secretRedaction.js";

export const POLICY_AUDIT_SCHEMA_VERSION = 1;

export interface PolicyAuditEntry {
  schemaVersion: number;
  timestamp: string;
  runId: string;
  workspace: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  allowed: boolean;
  reason?: string;
  input: Record<string, unknown>;
  previousHash: string | null;
  hash: string;
}

export interface PolicyAuditSink {
  append(entry: Omit<PolicyAuditEntry, "schemaVersion" | "timestamp" | "previousHash" | "hash">): PolicyAuditEntry;
}

function canonical(entry: Omit<PolicyAuditEntry, "hash">): string {
  return JSON.stringify(entry);
}

function digest(entry: Omit<PolicyAuditEntry, "hash">): string {
  return crypto.createHash("sha256").update(canonical(entry)).digest("hex");
}

/** JSONL audit log with a hash chain. Existing records are never rewritten. */
export class PolicyAuditLog implements PolicyAuditSink {
  constructor(readonly filePath: string) {}

  append(record: Omit<PolicyAuditEntry, "schemaVersion" | "timestamp" | "previousHash" | "hash">): PolicyAuditEntry {
    const previousHash = this.lastHash();
    const unsigned = {
      schemaVersion: POLICY_AUDIT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      ...redactSecrets(record),
      previousHash,
    };
    const entry: PolicyAuditEntry = { ...unsigned, hash: digest(unsigned) };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return entry;
  }

  verify(): { valid: boolean; entries: number; reason?: string } {
    if (!fs.existsSync(this.filePath)) return { valid: true, entries: 0 };
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
    let previousHash: string | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      try {
        const entry = JSON.parse(lines[index]) as PolicyAuditEntry;
        const { hash, ...unsigned } = entry;
        if (entry.schemaVersion !== POLICY_AUDIT_SCHEMA_VERSION || entry.previousHash !== previousHash || hash !== digest(unsigned)) {
          return { valid: false, entries: index, reason: "Policy audit hash chain is invalid" };
        }
        previousHash = hash;
      } catch {
        return { valid: false, entries: index, reason: "Policy audit record is malformed" };
      }
    }
    return { valid: true, entries: lines.length };
  }

  private lastHash(): string | null {
    const result = this.verify();
    if (!result.valid) throw new Error(result.reason);
    if (!result.entries) return null;
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
    return (JSON.parse(lines.at(-1)!) as PolicyAuditEntry).hash;
  }
}
