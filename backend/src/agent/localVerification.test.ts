import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolApproval } from "./toolApproval.js";
import { planLocalVerificationCommand } from "./localVerification.js";

test("ordinary local checks and safe check chains offer reusable approval while shells, mutating lint and network retain individual boundaries", () => {
  for (const command of ["python3 -B -m unittest discover -v", "python -m unittest test_limiter", "python3 -m pytest -q tests", "python -B -m ruff check --no-cache .", "ruff check src", "npm test", "pnpm run typecheck", "yarn build", "cd backend && npm test", "cd 'python project' && python3 -B -m unittest discover -v", "python -m unittest -v test_calc.py && ruff check calc.py test_calc.py", "cd backend && python -m unittest -v test_calc.py && ruff check calc.py test_calc.py"]) {
    const result = classifyToolApproval("bash", { command });
    assert.equal(result.kind, "approval", command);
    if (result.kind === "approval") { assert.equal(result.risk, "medium", command); assert.equal(result.canAllowSession, true, command); }
  }
  for (const command of ["python3 -m unittest | tail", "python3 -m unittest 2>&1 | tail -10", "npm test && node script.js", "python -m unittest -v test_calc.py && ruff check --fix calc.py", "python -m unittest -v test_calc.py || ruff check calc.py", "python -m unittest -v test_calc.py; ruff check calc.py", "python -m unittest -v test_calc.py $(echo calc.py)", "PYTHONPATH=. python -m unittest", "ruff check --fix .", "ruff check --fix-only .", "ruff check --unsafe-fixes .", "ruff check --add-noqa .", "ruff check --output-file=src/result .", "ruff check --config=fix=true .", "ruff check --config fix=true .", "ruff format .", "pytest --basetemp=src", "pytest -oaddopts=--basetemp=src", "python3 -m pytest --override-ini=addopts", "python3 -m pytest --override-ini addopts=--basetemp=src", "npm run lint -- --fix-only", "npm run lint -- --unsafe-fixes", "npm run lint -- --add-noqa", "npm run lint -- --output-file=src/result", "npm run lint -- --config=fix=true", "npm run test -- --updateSnapshot", "npm test -- --update-snapshot", "npm test -- --update-snapshots", "npm test -- --update", "npm test -- -u", "npm test -- --watch", "npm test -- --watchAll", "python3 -m unittest ../outside", "python3 script.py", "npm run deploy", "cd /tmp && npm test", "cd ../other && npm test", "cd .crewforge && npm test", "cd backend && npm test && node script.js"]) {
    const result = classifyToolApproval("bash", { command });
    assert.notEqual(result.kind === "approval" && result.risk, "medium", command);
  }
  for (const command of ["npm install", "npm publish", "curl https://example.test"]) assert.equal(classifyToolApproval("bash", { command }).kind, "blocked", command);
  const network = classifyToolApproval("bash", { command: "npm test", allow_network: true });
  assert.equal(network.kind === "approval" && network.risk, "high");
});


test("local verification planner decomposes only safe && chains with optional cwd", () => {
  assert.deepEqual(
    planLocalVerificationCommand("python -m unittest -v test_calc.py && ruff check calc.py test_calc.py"),
    { commands: ["python -m unittest -v test_calc.py", "ruff check calc.py test_calc.py"] }
  );
  assert.deepEqual(
    planLocalVerificationCommand("cd backend && python -m unittest -v test_calc.py && ruff check calc.py test_calc.py"),
    { cwd: "backend", commands: ["python -m unittest -v test_calc.py", "ruff check calc.py test_calc.py"] }
  );

  for (const command of [
    "python -m unittest -v test_calc.py | tail -10",
    "python -m unittest -v test_calc.py 2>&1",
    "python -m unittest -v test_calc.py || ruff check calc.py",
    "python -m unittest -v test_calc.py; ruff check calc.py",
    "PYTHONPATH=. python -m unittest",
    "python -m unittest -v test_calc.py && npm install",
    "python -m unittest -v test_calc.py && ruff check --fix calc.py",
    "python -m unittest -v test_calc.py && ruff check --config=fix=true calc.py",
    "npm run lint -- --fix-only",
    "npm test -- --watchAll",
    "npm test -- -uv",
    "npm test -- -vu",
    "npm test -- --u",
    "pytest -oaddopts=--basetemp=src",
    "cd /tmp && python -m unittest",
    "cd backend && python -m unittest && node script.js",
  ]) {
    assert.equal(planLocalVerificationCommand(command), null, command);
  }
});
