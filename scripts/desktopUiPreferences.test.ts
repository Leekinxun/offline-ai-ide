import assert from "node:assert/strict";
import test from "node:test";
import { createUiPreferenceStore } from "../frontend/src/desktop/preferences.js";
import type { DesktopPreferences } from "../frontend/src/desktop/bridge.js";

function browserStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("desktop preferences survive a new browser origin without moving authentication data", async () => {
  let saved: DesktopPreferences = {};
  const bridge = {
    getPreferences: async () => ({ ...saved }),
    setPreferences: async (patch: DesktopPreferences) => { saved = { ...saved, ...patch }; return { ...saved }; },
  };
  const first = createUiPreferenceStore(() => browserStorage({ theme: "dark", token: "private-token", "workspace-dir": "/private/project" }), () => bridge);
  await first.initialize();
  await first.set("editorFont", "Menlo, monospace");
  await first.set("user-zoom-level", "1.3");
  await first.set("app-locale", "zh-CN");
  const restarted = createUiPreferenceStore(() => browserStorage(), () => bridge);
  await restarted.initialize();
  assert.equal(restarted.get("theme"), "dark");
  assert.equal(restarted.get("editorFont"), "Menlo, monospace");
  assert.equal(restarted.get("user-zoom-level"), "1.3");
  assert.equal(restarted.get("app-locale"), "zh-CN");
  assert.deepEqual(Object.keys(saved).sort(), ["editorFont", "locale", "theme", "zoomLevel"]);
});

test("native preferences win over stale browser values and missing native fields migrate", async () => {
  const storage = browserStorage({ theme: "light", "user-zoom-level": "1.2", "app-locale": "zh-CN" });
  let saved: DesktopPreferences = { theme: "dark", locale: "en" };
  const store = createUiPreferenceStore(() => storage, () => ({
    getPreferences: async () => ({ ...saved }),
    setPreferences: async (patch) => { saved = { ...saved, ...patch }; return { ...saved }; },
  }));
  await store.initialize();
  assert.equal(store.get("theme"), "dark");
  assert.equal(store.get("app-locale"), "en");
  assert.equal(store.get("user-zoom-level"), "1.2");
  assert.deepEqual(saved, { theme: "dark", locale: "en", zoomLevel: 1.2 });
});

test("Web preferences continue to use browser storage", async () => {
  const storage = browserStorage({ theme: "light" });
  const store = createUiPreferenceStore(() => storage, () => undefined);
  await store.initialize();
  await store.set("theme", "dark");
  await store.set("app-locale", "zh-CN");
  assert.equal(storage.getItem("theme"), "dark");
  assert.equal(store.get("app-locale"), "zh-CN");
});

test("invalid migration values never enter the native preferences file", async () => {
  const storage = browserStorage({ theme: "unexpected", "user-zoom-level": "Infinity", "app-locale": "../../path", editorFont: " " });
  const writes: DesktopPreferences[] = [];
  const store = createUiPreferenceStore(() => storage, () => ({
    getPreferences: async () => ({}),
    setPreferences: async (patch) => { writes.push(patch); return patch; },
  }));
  await store.initialize();
  assert.deepEqual(writes, []);
  await assert.rejects(store.set("user-zoom-level", "3"), /Invalid UI preference/);
});

test("unreadable native preferences do not get overwritten with browser defaults", async () => {
  let writes = 0;
  const storage = browserStorage({ theme: "light" });
  const store = createUiPreferenceStore(() => storage, () => ({
    getPreferences: async () => { throw new Error("Unreadable preferences"); },
    setPreferences: async () => { writes += 1; return {}; },
  }));
  await assert.rejects(store.initialize(), /Unreadable preferences/);
  await store.set("theme", "dark");
  assert.equal(writes, 0);
});

test("blocked browser storage still permits native saves and a failed save can be retried", async () => {
  let fail = true;
  let saved: DesktopPreferences = { theme: "light" };
  const store = createUiPreferenceStore(() => { throw new Error("Storage denied"); }, () => ({
    getPreferences: async () => saved,
    setPreferences: async (patch) => {
      if (fail) throw new Error("Disk unavailable");
      saved = { ...saved, ...patch };
      return saved;
    },
  }));
  await store.initialize();
  await assert.rejects(store.set("theme", "dark"), /Disk unavailable/);
  fail = false;
  await store.set("theme", "dark");
  assert.equal(saved.theme, "dark");
  assert.equal(store.get("theme"), "dark");
});
