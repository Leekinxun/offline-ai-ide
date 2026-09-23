import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runWithIsolatedSettings(t: test.TestContext, script: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-llm-models-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "app-settings.json");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, APP_SETTINGS_CONFIG: file, WORKSPACE_DIR: directory, PLUGINS_DIR: path.join(directory, "plugins") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

test("additional LLM endpoints persist and legacy updates retain them", (t) => {
  const file = runWithIsolatedSettings(t, `
    import assert from "node:assert/strict";
    import { getLlmSettings, resolveModelEndpoint, updateLlmSettings } from "./src/config.ts";
    const saved = updateLlmSettings({
      ...getLlmSettings(), vllmApiUrl: "http://default.example/v1/", vllmApiKey: "default-key",
      modelName: "default-model", models: [
        { modelName: "remote-model", apiUrl: "https://remote.example/v1/", apiKey: "remote-key" },
        { modelName: "local-model", apiUrl: "http://localhost:1234/v1", apiKey: "" },
      ],
    });
    assert.equal(saved.vllmApiUrl, "http://default.example/v1");
    assert.equal(saved.models[0].apiUrl, "https://remote.example/v1");
    assert.deepEqual(resolveModelEndpoint("remote-model"), saved.models[0]);
    assert.deepEqual(resolveModelEndpoint("profile-model"), {
      modelName: "profile-model", apiUrl: saved.vllmApiUrl, apiKey: saved.vllmApiKey,
    });
    const { models: _models, ...legacyPayload } = saved;
    updateLlmSettings(legacyPayload);
    assert.deepEqual(getLlmSettings().models, saved.models);
    updateLlmSettings({ ...getLlmSettings(), vllmApiKey: "" });
    assert.equal(getLlmSettings().vllmApiKey, "");
  `);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(persisted.llm.models.map((model: { modelName: string }) => model.modelName), ["remote-model", "local-model"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reloaded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { getLlmSettings, resolveModelEndpoint } from "./src/config.ts";
    assert.equal(getLlmSettings().models.length, 2);
    assert.equal(getLlmSettings().vllmApiKey, "");
    assert.equal(resolveModelEndpoint("remote-model").apiUrl, "https://remote.example/v1");
  `], {
    cwd: process.cwd(),
    env: { ...process.env, APP_SETTINGS_CONFIG: file, WORKSPACE_DIR: path.dirname(file), PLUGINS_DIR: path.join(path.dirname(file), "plugins"), VLLM_API_KEY: "stale-env-key" },
    encoding: "utf8",
  });
  assert.equal(reloaded.status, 0, reloaded.stderr);
});

test("invalid additional LLM endpoints are rejected without mutating settings", (t) => {
  runWithIsolatedSettings(t, `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { getLlmSettings, LlmSettingsValidationError, updateLlmSettings } from "./src/config.ts";
    const baseline = updateLlmSettings({
      ...getLlmSettings(), vllmApiUrl: "http://default.example/v1", modelName: "default-model", models: [],
    });
    const bytes = fs.readFileSync(process.env.APP_SETTINGS_CONFIG, "utf8");
    const entry = { modelName: "other-model", apiUrl: "https://other.example/v1", apiKey: "key" };
    const invalid = [
      null,
      {},
      Array.from({ length: 33 }, (_, index) => ({ ...entry, modelName: "model-" + index })),
      [{ ...entry, modelName: "default-model" }],
      [entry, entry],
      [{ ...entry, modelName: " " }],
      [{ ...entry, apiUrl: "ftp://other.example/v1" }],
      [{ ...entry, apiUrl: "https://user:password@other.example/v1" }],
      [{ ...entry, apiUrl: "https://other.example/v1?token=secret" }],
      [{ ...entry, apiKey: null }],
    ];
    for (const models of invalid) {
      assert.throws(() => updateLlmSettings({ ...baseline, models }), LlmSettingsValidationError);
    }
    assert.throws(() => updateLlmSettings({ ...baseline, vllmApiUrl: "file:///tmp/unsafe", models: [] }), LlmSettingsValidationError);
    assert.deepEqual(getLlmSettings(), baseline);
    assert.equal(fs.readFileSync(process.env.APP_SETTINGS_CONFIG, "utf8"), bytes);
  `);
});
