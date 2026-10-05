import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t: test.TestContext): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-iteration-limit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "app-settings.json") };
}

function runConfigScript(
  t: test.TestContext,
  script: string,
  options: { settings?: unknown; env?: Record<string, string | undefined> } = {}
): string {
  const { directory, file } = fixture(t);
  if (options.settings !== undefined) {
    fs.writeFileSync(file, `${JSON.stringify(options.settings, null, 2)}\n`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_SETTINGS_CONFIG: file,
    WORKSPACE_DIR: directory,
    PLUGINS_DIR: path.join(directory, "plugins"),
    ...options.env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("saved max agent iterations survive startup and code profile resolution", (t) => {
  const output = runConfigScript(t, `
    import assert from "node:assert/strict";
    import { config, getLlmSettings } from "./src/config.ts";
    import { resolveAgentProfile } from "./src/agent/agentProfiles.ts";
    assert.equal(config.maxAgentIterations, 130);
    assert.equal(getLlmSettings().maxAgentIterations, 130);
    const profile = resolveAgentProfile("code", config.agentProfiles, {
      modelName: config.modelName,
      maxSteps: config.maxAgentIterations,
    });
    assert.equal(profile.budget.maxSteps, 130);
    console.log(JSON.stringify(getLlmSettings()));
  `, {
    settings: { llm: { maxAgentIterations: 130 } },
    env: { MAX_AGENT_ITERATIONS: "40" },
  });
  assert.equal(JSON.parse(output).maxAgentIterations, 130);
});

test("saved max agent iterations persist through an update and restart", (t) => {
  const { directory, file } = fixture(t);
  const env = {
    ...process.env,
    APP_SETTINGS_CONFIG: file,
    WORKSPACE_DIR: directory,
    PLUGINS_DIR: path.join(directory, "plugins"),
    MAX_AGENT_ITERATIONS: "40",
  };
  const first = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { getLlmSettings, updateLlmSettings } from "./src/config.ts";
    const saved = updateLlmSettings({ ...getLlmSettings(), maxAgentIterations: 130 });
    assert.equal(saved.maxAgentIterations, 130);
  `], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);

  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(persisted.llm.maxAgentIterations, 130);
  const second = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { config, getLlmSettings } from "./src/config.ts";
    assert.equal(config.maxAgentIterations, 130);
    assert.equal(getLlmSettings().maxAgentIterations, 130);
  `], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
});

test("missing saved iteration limit honors env then default", (t) => {
  const fromEnv = runConfigScript(t, `
    import { config } from "./src/config.ts";
    console.log(String(config.maxAgentIterations));
  `, { env: { MAX_AGENT_ITERATIONS: "40" } });
  assert.equal(fromEnv, "40");

  const fromDefault = runConfigScript(t, `
    import { config } from "./src/config.ts";
    console.log(String(config.maxAgentIterations));
  `, { env: { MAX_AGENT_ITERATIONS: undefined } });
  assert.equal(fromDefault, "30");
});

test("invalid saved iteration limit falls back safely without widening profile overrides", (t) => {
  const output = runConfigScript(t, `
    import assert from "node:assert/strict";
    import { config, getLlmSettings } from "./src/config.ts";
    import { resolveAgentProfile } from "./src/agent/agentProfiles.ts";
    assert.equal(config.maxAgentIterations, 40);
    assert.equal(getLlmSettings().maxAgentIterations, 40);
    const globalProfile = resolveAgentProfile("code", config.agentProfiles, {
      modelName: config.modelName,
      maxSteps: config.maxAgentIterations,
    });
    const explicitProfile = resolveAgentProfile("code", { code: { budget: { maxSteps: 12 } } }, {
      modelName: config.modelName,
      maxSteps: config.maxAgentIterations,
    });
    assert.equal(globalProfile.budget.maxSteps, 40);
    assert.equal(explicitProfile.budget.maxSteps, 12);
    console.log(JSON.stringify({ config: config.maxAgentIterations, settings: getLlmSettings().maxAgentIterations }));
  `, {
    settings: { llm: { maxAgentIterations: "many" } },
    env: { MAX_AGENT_ITERATIONS: "40" },
  });
  assert.deepEqual(JSON.parse(output), { config: 40, settings: 40 });
});
