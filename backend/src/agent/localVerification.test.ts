import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolApproval } from "./toolApproval.js";

test("ordinary local checks offer reusable approval while shells, mutating lint and network retain individual boundaries", () => {
  for (const command of ["python3 -B -m unittest discover -v", "python -m unittest test_limiter", "python3 -m pytest -q tests", "python -B -m ruff check --no-cache .", "ruff check src", "npm test", "pnpm run typecheck", "yarn build", "cd backend && npm test", "cd 'python project' && python3 -B -m unittest discover -v"]) {
    const result = classifyToolApproval("bash", { command });
    assert.equal(result.kind, "approval", command);
    if (result.kind === "approval") { assert.equal(result.risk, "medium", command); assert.equal(result.canAllowSession, true, command); }
  }
  for (const command of ["python3 -m unittest | tail", "npm test && node script.js", "ruff check --fix .", "ruff check --fix-only .", "ruff format .", "pytest --basetemp=src", "npm run test -- --updateSnapshot", "python3 -m unittest ../outside", "python3 script.py", "npm run deploy", "python3 -m pytest --override-ini=addopts", "ruff check --output-file=src/result .", "cd /tmp && npm test", "cd ../other && npm test", "cd .crewforge && npm test", "cd backend && npm test && node script.js"]) {
    const result = classifyToolApproval("bash", { command });
    assert.notEqual(result.kind === "approval" && result.risk, "medium", command);
  }
  for (const command of ["npm install", "npm publish", "curl https://example.test"]) assert.equal(classifyToolApproval("bash", { command }).kind, "blocked", command);
  const network = classifyToolApproval("bash", { command: "npm test", allow_network: true });
  assert.equal(network.kind === "approval" && network.risk, "high");
});
