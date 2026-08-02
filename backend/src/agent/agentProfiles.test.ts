import assert from "node:assert/strict";
import test from "node:test";
import {
  agentProfileAllowsTool,
  estimateUsageCostUsd,
  normalizeAgentProfileOverrides,
  resolveAgentProfile,
} from "./agentProfiles.js";

test("resolves per-agent model, budgets, pricing, and narrowed permissions", () => {
  const overrides = normalizeAgentProfileOverrides({
    code: {
      modelName: "code-model",
      budget: { maxSteps: 12, maxToolCalls: 20, maxCostUsd: 1.5 },
      permissions: { allow: ["read_*", "write_file"], deny: ["read_secret"] },
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
    },
  });
  const profile = resolveAgentProfile("code", overrides, { modelName: "fallback" });
  assert.equal(profile.modelName, "code-model");
  assert.equal(profile.budget.maxSteps, 12);
  assert.equal(profile.budget.maxCostUsd, 1.5);
  assert.equal(agentProfileAllowsTool(profile, "read_file"), true);
  assert.equal(agentProfileAllowsTool(profile, "read_secret"), false);
  assert.equal(agentProfileAllowsTool(profile, "bash"), false);
  assert.equal(estimateUsageCostUsd(profile, 1_000_000, 500_000), 6);
});

test("keeps child defaults narrower than the primary code agent", () => {
  const explore = resolveAgentProfile("explore");
  assert.equal(agentProfileAllowsTool(explore, "read_file"), true);
  assert.equal(agentProfileAllowsTool(explore, "write_file"), false);
});

test("keeps read-only modes narrower than the code profile", () => {
  const code = resolveAgentProfile("code");
  const plan = resolveAgentProfile("plan");
  assert.equal(agentProfileAllowsTool(code, "mcp_weather__forecast"), true);
  assert.equal(agentProfileAllowsTool(plan, "mcp_weather__forecast"), false);
  assert.equal(agentProfileAllowsTool(plan, "submit_plan"), true);
  assert.equal(agentProfileAllowsTool(plan, "bash"), true);
});
