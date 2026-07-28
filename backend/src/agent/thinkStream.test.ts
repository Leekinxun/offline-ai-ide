import assert from "node:assert/strict";
import test from "node:test";
import { ThinkStreamSplitter } from "./thinkStream.js";

test("separates think tags split across provider chunks", () => {
  let content = "";
  let thinking = "";
  const splitter = new ThinkStreamSplitter(
    (value) => { content += value; },
    (value) => { thinking += value; }
  );
  for (const part of ["before<th", "ink>secret</thi", "nk>after"]) splitter.push(part);
  splitter.flush();
  assert.equal(content, "beforeafter");
  assert.equal(thinking, "secret");
});

test("streams ordinary text without losing tag-like suffixes", () => {
  let content = "";
  const splitter = new ThinkStreamSplitter(
    (value) => { content += value; },
    () => undefined
  );
  splitter.push("one <thin");
  splitter.push(" air two");
  splitter.flush();
  assert.equal(content, "one <thin air two");
});
