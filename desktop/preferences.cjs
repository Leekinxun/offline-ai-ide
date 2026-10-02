const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const validators = {
  theme: (value) => value === "light" || value === "dark",
  editorFont: (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value),
  zoomLevel: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0.7 && value <= 1.6,
  locale: (value) => typeof value === "string" && value.length <= 64 && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(value),
};

function validatePreferencePatch(value) {
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") throw new TypeError("Invalid desktop preferences");
  const patch = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(validators, key) || !validators[key](value[key])) throw new TypeError(`Invalid desktop preference: ${key}`);
    patch[key] = value[key];
  }
  return patch;
}

function readPreferences(file, fileSystem) {
  let value;
  try {
    if (fileSystem.statSync(file).size > 16_384) return {};
    value = JSON.parse(fileSystem.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
  const preferences = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(validators)) {
      if (Object.hasOwn(value, key) && validators[key](value[key])) preferences[key] = value[key];
    }
  }
  return preferences;
}

function createPreferencesStore(file, fileSystem = fs) {
  let preferences = readPreferences(file, fileSystem);
  return {
    get: () => ({ ...preferences }),
    set(value) {
      const patch = validatePreferencePatch(value);
      const next = { ...preferences, ...patch };
      fileSystem.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
      try {
        fileSystem.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        fileSystem.renameSync(temporary, file);
      } finally {
        fileSystem.rmSync(temporary, { force: true });
      }
      // Synchronous merge/write keeps concurrent IPC patches in their arrival order.
      preferences = next;
      return { ...preferences };
    },
  };
}

module.exports = { createPreferencesStore, validatePreferencePatch };
