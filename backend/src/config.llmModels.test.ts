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
        { modelName: "remote-model-2", apiUrl: "https://remote.example/v1/", apiKey: "remote-key" },
        { modelName: "local-model", apiUrl: "http://localhost:1234/v1", apiKey: "" },
      ],
    });
    assert.equal(saved.vllmApiUrl, "http://default.example/v1");
    assert.equal(saved.models[0].apiUrl, "https://remote.example/v1");
    assert.deepEqual(resolveModelEndpoint("remote-model"), saved.models[0]);
    assert.deepEqual(resolveModelEndpoint("remote-model-2"), saved.models[1]);
    assert.equal(saved.models[0].apiUrl, saved.models[1].apiUrl);
    assert.equal(saved.models[0].apiKey, saved.models[1].apiKey);
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
  assert.deepEqual(persisted.llm.models.map((model: { modelName: string }) => model.modelName), ["remote-model", "remote-model-2", "local-model"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reloaded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { getLlmSettings, resolveModelEndpoint } from "./src/config.ts";
    assert.equal(getLlmSettings().models.length, 3);
    assert.equal(getLlmSettings().vllmApiKey, "");
    assert.equal(resolveModelEndpoint("remote-model").apiUrl, "https://remote.example/v1");
    assert.deepEqual(resolveModelEndpoint("remote-model-2"), getLlmSettings().models[1]);
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

test("model sampling overrides inherit defaults, preserve zero, and survive reload", (t) => {
  const file = runWithIsolatedSettings(t, `
    import assert from "node:assert/strict";
    import { getLlmSettings, resolveModelSampling, updateLlmSettings } from "./src/config.ts";
    const saved = updateLlmSettings({
      ...getLlmSettings(), vllmApiUrl: "https://default.example/v1", modelName: "default-model",
      maxTokens: 2048, temperature: 0, topP: 0.7, frequencyPenalty: -0.4, presencePenalty: 0,
      models: [{ modelName: "child", apiUrl: "https://shared.example/v1", apiKey: "shared-key", maxTokens: 512, topP: 0, frequencyPenalty: 1.5 }],
    });
    assert.deepEqual(resolveModelSampling("default-model"), { maxTokens: 2048, temperature: 0, topP: 0.7, frequencyPenalty: -0.4, presencePenalty: 0 });
    assert.deepEqual(resolveModelSampling("child"), { maxTokens: 512, temperature: 0, topP: 0, frequencyPenalty: 1.5, presencePenalty: 0 });
    const { temperature: _temperature, topP: _topP, ...legacyPayload } = saved;
    updateLlmSettings(legacyPayload);
    assert.equal(getLlmSettings().temperature, 0);
    assert.equal(getLlmSettings().topP, 0.7);
  `);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(persisted.llm.temperature, 0);
  assert.equal(persisted.llm.models[0].maxTokens, 512);
  const reloaded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { getLlmSettings, resolveModelSampling } from "./src/config.ts";
    assert.equal(getLlmSettings().temperature, 0);
    assert.deepEqual(resolveModelSampling("child"), { maxTokens: 512, temperature: 0, topP: 0, frequencyPenalty: 1.5, presencePenalty: 0 });
  `], { cwd: process.cwd(), env: { ...process.env, APP_SETTINGS_CONFIG: file, WORKSPACE_DIR: path.dirname(file), PLUGINS_DIR: path.join(path.dirname(file), "plugins") }, encoding: "utf8" });
  assert.equal(reloaded.status, 0, reloaded.stderr);
});

test("explicit null clears default sampling while invalid values never mutate settings", (t) => {
  const file = runWithIsolatedSettings(t, `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { getLlmSettings, LlmSettingsValidationError, resolveModelSampling, updateLlmSettings } from "./src/config.ts";
    const baseline = updateLlmSettings({
      ...getLlmSettings(), vllmApiUrl: "https://default.example/v1", modelName: "default-model",
      maxTokens: 2048, temperature: 0.8, topP: 0.9, frequencyPenalty: 0.3, presencePenalty: -0.2,
      models: [{ modelName: "child", apiUrl: "https://shared.example/v1", apiKey: "key", topP: 0 }],
    });
    const bytes = fs.readFileSync(process.env.APP_SETTINGS_CONFIG, "utf8");
    const entry = baseline.models[0];
    const badUpdates = [
      { temperature: -0.1 }, { temperature: 2.1 }, { temperature: "0.5" },
      { topP: -0.1 }, { topP: 1.1 }, { topP: Infinity },
      { frequencyPenalty: -2.1 }, { frequencyPenalty: 2.1 },
      { presencePenalty: -2.1 }, { presencePenalty: "1" },
      { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: 1_000_001 },
      { models: [{ ...entry, topP: null }] },
      { models: [{ ...entry, frequencyPenalty: "0" }] },
      { models: [{ ...entry, maxTokens: 0 }] },
      { models: [{ ...entry, maxTokens: 1.5 }] },
      { models: [{ ...entry, maxTokens: 1_000_001 }] },
    ];
    for (const update of badUpdates) {
      assert.throws(() => updateLlmSettings({ ...baseline, ...update }), LlmSettingsValidationError);
      assert.deepEqual(getLlmSettings(), baseline);
      assert.equal(fs.readFileSync(process.env.APP_SETTINGS_CONFIG, "utf8"), bytes);
    }
    const cleared = updateLlmSettings({ ...baseline, temperature: null, topP: null, frequencyPenalty: null, presencePenalty: null });
    for (const field of ["temperature", "topP", "frequencyPenalty", "presencePenalty"]) assert.equal(field in cleared, false);
    assert.deepEqual(resolveModelSampling("default-model"), { maxTokens: 2048 });
    assert.deepEqual(resolveModelSampling("child"), { maxTokens: 2048, topP: 0 });
  `);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const field of ["temperature", "topP", "frequencyPenalty", "presencePenalty"]) assert.equal(persisted.llm[field], null);
  const reloaded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { getLlmSettings, resolveModelSampling } from "./src/config.ts";
    assert.equal(getLlmSettings().temperature, undefined);
    assert.deepEqual(resolveModelSampling("child"), { maxTokens: 2048, topP: 0 });
  `], { cwd: process.cwd(), env: { ...process.env, AGENT_TEMPERATURE: "0.9", APP_SETTINGS_CONFIG: file, WORKSPACE_DIR: path.dirname(file), PLUGINS_DIR: path.join(path.dirname(file), "plugins") }, encoding: "utf8" });
  assert.equal(reloaded.status, 0, reloaded.stderr);
});

test("image and PDF input are enabled only for explicitly configured models", (t) => {
  runWithIsolatedSettings(t, `
    import assert from "node:assert/strict";
    import { getLlmSettings, resolveModelInputCapabilities, updateLlmSettings } from "./src/config.ts";
    const saved = updateLlmSettings({
      ...getLlmSettings(), vllmApiUrl: "https://models.example/v1", modelName: "vision-default",
      supportsImageInput: true, supportsPdfInput: false,
      models: [
        { modelName: "pdf-model", apiUrl: "https://models.example/v1", apiKey: "", supportsImageInput: true, supportsPdfInput: true },
        { modelName: "text-only", apiUrl: "https://models.example/v1", apiKey: "" },
      ],
    });
    assert.deepEqual(resolveModelInputCapabilities("vision-default"), { image_input: true, pdf_input: false });
    assert.deepEqual(resolveModelInputCapabilities("pdf-model"), { image_input: true, pdf_input: true });
    assert.deepEqual(resolveModelInputCapabilities("text-only"), { image_input: false, pdf_input: false });
    assert.deepEqual(resolveModelInputCapabilities("unknown-profile"), { image_input: false, pdf_input: false });
    assert.throws(() => updateLlmSettings({ ...saved, supportsImageInput: "yes" }));
    assert.throws(() => updateLlmSettings({ ...saved, models: [{ ...saved.models[0], supportsPdfInput: "yes" }] }));
    assert.deepEqual(getLlmSettings(), saved);
  `);
});
