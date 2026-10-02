import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionFactsCard } from "../src/components/ExecutionFactsCard.tsx";
import { EN_MESSAGES } from "../src/i18n/messages.ts";
import type { ExecutionFactsSummary } from "../src/types/index.ts";

const t = (key: string, values?: Record<string, string | number>) => (EN_MESSAGES[key] || key).replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`));
const render = (facts?: ExecutionFactsSummary) => renderToStaticMarkup(<ExecutionFactsCard facts={facts} t={t} />);
const fixture = (overrides: Partial<ExecutionFactsSummary> = {}): ExecutionFactsSummary => ({
  schemaVersion: 1, completeness: "complete", toolCalls: 301, successfulToolCalls: 301, failedToolCalls: 0, deniedToolCalls: 0,
  fileReads: 301, duplicateFileReads: 298, pagedFileReads: 1, updatedFileReads: 1, unclassifiedFileReads: 0,
  readRanges: [
    { path: "logs/a.txt", version: "sha256:version-one", start: 0, end: 25_000, complete: false, count: 299, firstToolCallId: "read-1", lastToolCallId: "read-299" },
    { path: "logs/a.txt", version: "sha256:version-one", start: 25_000, end: 50_000, complete: false, count: 1, firstToolCallId: "read-300", lastToolCallId: "read-300" },
    { path: "logs/a.txt", version: "sha256:version-two", start: 0, end: 50_000, complete: true, count: 1, firstToolCallId: "read-301", lastToolCallId: "read-301" },
  ],
  compactions: { summaryCount: 4, failedCount: 1, fallbackTrimCount: 1, last: { outcome: "fallback_trim", tokensBefore: 61_000, tokensAfter: 17_000 } },
  ...overrides,
});

test("recorded counts and exact read evidence remain visible past the tool-history cap", () => {
  const html = render(fixture());
  assert.match(html, /data-completeness="complete"/);
  assert.match(html, /Reads 301 · Repeats 298 · Summaries 4/);
  assert.match(html, /Repeated version and range/);
  assert.match(html, /Other ranges read/);
  assert.match(html, /New versions read/);
  assert.match(html, /Character range 25000–50000/);
  assert.match(html, /read-1 → read-299/);
  assert.match(html, /sha256:version-two/);
});

test("actual fallback status and token counts are shown independently from model success claims", () => {
  const html = render(fixture());
  assert.match(html, /Failed summaries/);
  assert.match(html, /Fallback trims/);
  assert.match(html, /Trimmed after failure/);
  assert.match(html, /61000 → 17000 tokens/);
  assert.doesNotMatch(html, /Summary generated/);
});

test("legacy, incomplete, and malformed payloads cannot imply a zero-reread conclusion", () => {
  for (const facts of [undefined, fixture({ completeness: "unknown", fileReads: 0, duplicateFileReads: 0 }), { schemaVersion: 1, completeness: "complete" } as ExecutionFactsSummary]) {
    const html = render(facts);
    assert.match(html, /data-completeness="unknown"/);
    assert.match(html, /Cannot fully confirm/);
    assert.match(html, /missing records cannot prove/);
    assert.doesNotMatch(html, /Reads 0 · Repeats 0/);
    assert.doesNotMatch(html, />Complete record</);
  }
  assert.match(render(fixture({ completeness: "unknown", fileReads: 0 })), /Recorded: 0/);
});

test("large evidence lists remain bounded and literal metadata is escaped", () => {
  const base = fixture();
  const readRanges = Array.from({ length: 40 }, (_, index) => ({ ...base.readRanges[0], path: index === 0 ? '<img src="bad" onerror="bad">' : `logs/${index}.txt`, count: index === 39 ? 2 : 1 }));
  const html = render(fixture({ readRanges }));
  assert.equal((html.match(/<li(?:\s|>)/g) || []).length, 20);
  assert.match(html, /Showing 20\/40 entries/);
  assert.ok(html.indexOf("logs/39.txt") < html.indexOf("&lt;img"));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("optional visual QA artifact renders complete and legacy cards at narrow and wide sizes", () => {
  if (!process.env.CREWFORGE_FACTS_QA_HTML) return;
  const stylesheet = fs.readFileSync(path.resolve("src/components/ExecutionFactsCard.css"), "utf8");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Execution facts QA</title><style>
    :root{--line-subtle:#c7ccd4;--border-light:#c7ccd4;--bg-secondary:#f4f6f8;--bg-primary:#fff;--text-primary:#222b36;--text-secondary:#596573;--text-tertiary:#65717e;--warning:#8a5b0d;--accent:#2269c5}*{box-sizing:border-box}body{font:14px system-ui;margin:24px;background:#e5e9ee}main{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}.narrow{width:320px}.wide{width:620px}h2{font-size:14px;margin:8px 10px}${stylesheet}
    </style><main><section class="narrow"><h2>Narrow assistant panel</h2>${render(fixture()).replace('<details ', '<details open ')}${render().replace('<details ', '<details open ')}</section><section class="wide"><h2>Wide chat panel</h2>${render(fixture()).replace('<details ', '<details open ')}</section></main></html>`;
  fs.writeFileSync(process.env.CREWFORGE_FACTS_QA_HTML, html);
});
