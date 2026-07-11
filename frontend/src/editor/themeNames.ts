export const EDITOR_THEME_LIGHT_NAME = "offline-ai-light";
export const EDITOR_THEME_DARK_NAME = "offline-ai-dark";

export function getEditorThemeName(theme: "light" | "dark"): string {
  return theme === "dark" ? EDITOR_THEME_DARK_NAME : EDITOR_THEME_LIGHT_NAME;
}
