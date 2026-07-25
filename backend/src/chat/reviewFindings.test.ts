import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewFindings } from "./reviewFindings.js";

test("parses, normalizes and severity-sorts review findings", () => {
  const findings = parseReviewFindings([
    "- [info] `src/a.ts:8` — Consider a clearer name",
    "- [HIGH] ./src/b.ts:4:2 - This can throw",
    "- [warning] src/a.ts:12:3: Missing boundary test",
  ].join("\n"));

  assert.deepEqual(
    findings.map(({ severity, path, line, column, message }) => ({ severity, path, line, column, message })),
    [
      { severity: "critical", path: "src/b.ts", line: 4, column: 2, message: "This can throw" },
      { severity: "warning", path: "src/a.ts", line: 12, column: 3, message: "Missing boundary test" },
      { severity: "info", path: "src/a.ts", line: 8, column: undefined, message: "Consider a clearer name" },
    ]
  );
});

test("ignores prose, no-findings markers and invalid locations", () => {
  assert.deepEqual(
    parseReviewFindings([
      "No findings.",
      "[warning] src/a.ts:0 — Invalid line",
      "This is ordinary prose.",
    ].join("\n")),
    []
  );
});

test("deduplicates identical review findings", () => {
  const line = "- [error] `src/a.ts:2:1` — Broken branch";
  assert.equal(parseReviewFindings(`${line}\n${line}`).length, 1);
});
