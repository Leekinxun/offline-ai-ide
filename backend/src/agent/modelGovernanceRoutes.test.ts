import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { modelGovernanceRouter } from "../routes/modelGovernance.js";

test("model governance routes enforce ownership, CAS, warnings, and pre-egress exhaustion", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-model-governance-routes-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).userSession = { workspaceDir, username: "admin", isAdmin: true }; next(); });
  app.use(modelGovernanceRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  assert.deepEqual(await (await fetch(`${base}/budgets`)).json(), { budgets: [] });
  const missingVersion = await fetch(`${base}/budgets/workspace/workspace`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: { maxTokens: 10 } }) });
  assert.equal(missingVersion.status, 428);
  const created = await fetch(`${base}/budgets/workspace/workspace`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: 0, policy: { maxTokens: 10, warningRatio: 0.5 } }) });
  assert.equal(created.status, 200);
  assert.equal(((await created.json()) as { budget: { version: number } }).budget.version, 1);
  const conflict = await fetch(`${base}/budgets/workspace/workspace`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: 0, policy: { maxTokens: 20 } }) });
  assert.equal(conflict.status, 409);
  const warning = await fetch(`${base}/budgets/preflight`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scopes: [{ kind: "workspace", id: "workspace" }], estimatedTokens: 5, estimatedCostUsd: 0 }) });
  assert.equal(warning.status, 200);
  assert.equal(((await warning.json()) as { preflight: { warnings: unknown[] } }).preflight.warnings.length, 1);
  const exhausted = await fetch(`${base}/budgets/preflight`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scopes: [{ kind: "workspace", id: "workspace" }], estimatedTokens: 11, estimatedCostUsd: 0 }) });
  assert.equal(exhausted.status, 409);
  assert.deepEqual(await exhausted.json(), { code: "budget_exhausted", recoverable: true, error: "Model budget exhausted for workspace:workspace" });
});
