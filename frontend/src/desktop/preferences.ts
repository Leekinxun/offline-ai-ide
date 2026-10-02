import { getDesktopBridge, type DesktopBridge, type DesktopPreferences } from "./bridge";

export type UiPreferenceKey = "theme" | "editorFont" | "user-zoom-level" | "app-locale";
interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const preferenceFields = {
  theme: "theme",
  editorFont: "editorFont",
  "user-zoom-level": "zoomLevel",
  "app-locale": "locale",
} as const;

function preferencePatch(key: UiPreferenceKey, value: string): DesktopPreferences | null {
  if (key === "theme") return value === "light" || value === "dark" ? { theme: value } : null;
  if (key === "editorFont") return value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? { editorFont: value } : null;
  if (key === "app-locale") return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) && value.length <= 64 ? { locale: value } : null;
  const zoomLevel = Number(value);
  return value.trim() && Number.isFinite(zoomLevel) && zoomLevel >= 0.7 && zoomLevel <= 1.6 ? { zoomLevel } : null;
}

function validPreferences(input: DesktopPreferences): DesktopPreferences {
  const result: DesktopPreferences = {};
  for (const key of Object.keys(preferenceFields) as UiPreferenceKey[]) {
    const value = input?.[preferenceFields[key]];
    if (value !== undefined) Object.assign(result, preferencePatch(key, String(value)) ?? {});
  }
  return result;
}

export function createUiPreferenceStore(
  storage: () => PreferenceStorage,
  bridge: () => Pick<DesktopBridge, "getPreferences" | "setPreferences"> | undefined,
) {
  let native: ReturnType<typeof bridge>;
  let preferences: DesktopPreferences = {};
  const readBrowser = (key: UiPreferenceKey) => {
    try { return storage().getItem(key); } catch { return null; }
  };

  return {
    async initialize(): Promise<void> {
      const candidate = bridge();
      if (!candidate) return;
      // Do not overwrite an unreadable native file with browser defaults.
      preferences = validPreferences(await candidate.getPreferences());
      const migration: DesktopPreferences = {};
      for (const key of Object.keys(preferenceFields) as UiPreferenceKey[]) {
        if (preferences[preferenceFields[key]] !== undefined) continue;
        const value = readBrowser(key);
        if (value !== null) Object.assign(migration, preferencePatch(key, value) ?? {});
      }
      if (Object.keys(migration).length) {
        preferences = validPreferences(await candidate.setPreferences(migration));
      }
      native = candidate;
    },
    get(key: UiPreferenceKey): string | null {
      const value = preferences[preferenceFields[key]];
      return native && value !== undefined ? String(value) : readBrowser(key);
    },
    async set(key: UiPreferenceKey, value: string): Promise<void> {
      const patch = preferencePatch(key, value);
      if (!patch) throw new Error("Invalid UI preference");
      const unchanged = native && preferences[preferenceFields[key]] === patch[preferenceFields[key]];
      try { storage().setItem(key, value); } catch { /* Native storage remains available. */ }
      if (!native || unchanged) return;
      Object.assign(preferences, patch);
      try {
        await native.setPreferences(patch);
      } catch (error) {
        // Allow a later explicit save to retry the same value.
        if (preferences[preferenceFields[key]] === patch[preferenceFields[key]]) delete preferences[preferenceFields[key]];
        throw error;
      }
    },
  };
}

const store = createUiPreferenceStore(() => localStorage, getDesktopBridge);
export const initializeUiPreferences = () => store.initialize();
export const readUiPreference = (key: UiPreferenceKey) => store.get(key);
export function saveUiPreference(key: UiPreferenceKey, value: string): void {
  void store.set(key, value).catch(() => {
    console.warn("CrownForge could not save a UI preference.");
  });
}
