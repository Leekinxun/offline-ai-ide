import { createHash } from "node:crypto";

export type ToolLoopAction = "allow" | "warn" | "block";

export interface ToolLoopDecision {
  action: ToolLoopAction;
  consecutiveCount: number;
  fingerprint: string;
  message?: string;
}

export class ToolLoopGuard {
  private lastFingerprint?: string;
  private consecutiveCount = 0;

  constructor(
    private readonly warnAt = 3,
    private readonly blockAt = 4
  ) {
    if (warnAt < 2 || blockAt <= warnAt) {
      throw new Error("Tool loop thresholds must satisfy 2 <= warnAt < blockAt");
    }
  }

  inspect(name: string, input: Record<string, unknown>): ToolLoopDecision {
    const fingerprint = fingerprintToolCall(name, input);
    if (fingerprint === this.lastFingerprint) {
      this.consecutiveCount += 1;
    } else {
      this.lastFingerprint = fingerprint;
      this.consecutiveCount = 1;
    }

    if (this.consecutiveCount >= this.blockAt) {
      return {
        action: "block",
        consecutiveCount: this.consecutiveCount,
        fingerprint,
        message: `Blocked identical tool call after ${this.consecutiveCount} consecutive attempts. Change the arguments or choose a different action.`,
      };
    }
    if (this.consecutiveCount >= this.warnAt) {
      return {
        action: "warn",
        consecutiveCount: this.consecutiveCount,
        fingerprint,
        message: `Warning: this is identical tool call ${this.consecutiveCount} in a row. Do not repeat it again without changing the approach.`,
      };
    }
    return { action: "allow", consecutiveCount: this.consecutiveCount, fingerprint };
  }
}

export function fingerprintToolCall(
  name: string,
  input: Record<string, unknown>
): string {
  return createHash("sha256")
    .update(`${name}\n${stableStringify(input)}`)
    .digest("hex")
    .slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}
