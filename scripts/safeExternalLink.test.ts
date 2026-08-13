import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "../frontend/node_modules/react/index.js";
import { renderToStaticMarkup } from "../frontend/node_modules/react-dom/server.js";
import { SafeExternalLink, safeExternalHref } from "../frontend/src/components/SafeExternalLink.js";

interface ProviderUrlCorpus {
  schemaVersion: number;
  valid: Array<{ id: string; input: string; allowLoopbackHttp: boolean; expected: string }>;
  invalid: Array<{ id: string; input: string; allowLoopbackHttp: boolean }>;
}
const providerUrlCorpus = JSON.parse(fs.readFileSync(new URL("./fixtures/provider-url-corpus.json", import.meta.url), "utf8")) as ProviderUrlCorpus;

test("safe external href accepts HTTPS and rejects active or ambiguous URL forms", () => {
  assert.equal(providerUrlCorpus.schemaVersion, 1);
  for (const entry of providerUrlCorpus.valid) assert.equal(safeExternalHref(entry.input, { allowLoopbackHttp: entry.allowLoopbackHttp }), entry.expected, entry.id);
  for (const entry of providerUrlCorpus.invalid) assert.equal(safeExternalHref(entry.input, { allowLoopbackHttp: entry.allowLoopbackHttp }), undefined, entry.id);
});

test("safe external link renders hardened anchors and omits unsafe links", () => {
  const safeHref = providerUrlCorpus.valid.find((entry) => entry.id === "https-github-proposal")!.input;
  const unsafeHref = providerUrlCorpus.invalid.find((entry) => entry.id === "javascript-scheme")!.input;
  const safe = renderToStaticMarkup(React.createElement(SafeExternalLink, { href: safeHref, "aria-label": "Open" }, "Open"));
  assert.match(safe, /href="https:\/\/github\.com\/acme\/repo\/pull\/1"/);
  assert.match(safe, /target="_blank"/);
  assert.match(safe, /rel="noopener noreferrer"/);
  assert.equal(renderToStaticMarkup(React.createElement(SafeExternalLink, { href: unsafeHref }, "Unsafe")), "");
});
