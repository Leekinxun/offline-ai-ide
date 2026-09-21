import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { findPythonDefinition, findPythonReferences } from "./pythonLanguageService.js";

function workspace(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-python-language-service-"));
  fs.mkdirSync(path.join(root, "pkg"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("resolves Python imports and references through Jedi when available", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "pkg", "service.py"), "def calculate_total(value):\n    return value + 1\n");
  fs.writeFileSync(path.join(root, "pkg", "consumer.py"), "from .service import calculate_total\nresult = calculate_total(2)\n");

  const definition = await findPythonDefinition(root, "pkg/consumer.py", "calculate_total");
  assert.equal(definition?.path, "pkg/service.py");
  const references = await findPythonReferences(root, "pkg/service.py", "calculate_total");
  assert.equal(references.some((entry) => entry.path === "pkg/consumer.py"), true);
});
