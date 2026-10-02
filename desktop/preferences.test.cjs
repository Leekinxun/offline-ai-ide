const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createPreferencesStore, validatePreferencePatch } = require("./preferences.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-preferences-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "preferences.json") };
}

test("preferences survive a new app instance and patches retain independent fields", (t) => {
  const { file } = fixture(t);
  const first = createPreferencesStore(file);
  assert.deepEqual(first.get(), {});
  first.set({ theme: "dark", editorFont: "'Cascadia Code', Consolas, monospace" });
  first.set({ zoomLevel: 1.2 });
  first.set({ locale: "zh-CN" });
  const restarted = createPreferencesStore(file);
  assert.deepEqual(restarted.get(), { theme: "dark", editorFont: "'Cascadia Code', Consolas, monospace", zoomLevel: 1.2, locale: "zh-CN" });
  const copy = restarted.get();
  copy.theme = "light";
  assert.equal(restarted.get().theme, "dark");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("invalid patches never partially update memory or disk", (t) => {
  const { file } = fixture(t);
  const store = createPreferencesStore(file);
  store.set({ theme: "light" });
  const original = fs.readFileSync(file, "utf8");
  const invalid = [null, [], new Date(), new Map(), { token: "secret" }, { theme: "system" }, { theme: "dark", zoomLevel: 1.7 },
    { zoomLevel: NaN }, { zoomLevel: "1.2" }, { editorFont: "" }, { editorFont: "a\nb" },
    { editorFont: "a".repeat(257) }, { locale: "zh_CN" }, { locale: "a".repeat(65) },
    JSON.parse('{"__proto__":{"theme":"dark"}}')];
  for (const patch of invalid) {
    assert.throws(() => store.set(patch), /Invalid desktop preference/);
    assert.deepEqual(store.get(), { theme: "light" });
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
  assert.deepEqual(validatePreferencePatch({ zoomLevel: 0.7 }), { zoomLevel: 0.7 });
  assert.deepEqual(validatePreferencePatch({ zoomLevel: 1.6 }), { zoomLevel: 1.6 });
});

test("a failed atomic rename preserves previous preferences and cleans its temporary file", (t) => {
  const { directory, file } = fixture(t);
  createPreferencesStore(file).set({ theme: "light" });
  const store = createPreferencesStore(file, { ...fs, renameSync: () => { throw new Error("simulated rename failure"); } });
  assert.throws(() => store.set({ theme: "dark" }), /simulated rename failure/);
  assert.deepEqual(store.get(), { theme: "light" });
  assert.deepEqual(createPreferencesStore(file).get(), { theme: "light" });
  assert.deepEqual(fs.readdirSync(directory), ["preferences.json"]);
});

test("loading damaged preferences keeps only validated known values", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ theme: "dark", editorFont: "", zoomLevel: 10, locale: "en-US", token: "not exposed" }));
  assert.deepEqual(createPreferencesStore(file).get(), { theme: "dark", locale: "en-US" });
  fs.writeFileSync(file, "{broken");
  assert.deepEqual(createPreferencesStore(file).get(), {});
  fs.writeFileSync(file, " ".repeat(16_385));
  assert.deepEqual(createPreferencesStore(file).get(), {});
});
