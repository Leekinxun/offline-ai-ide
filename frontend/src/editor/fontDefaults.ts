// Match VS Code's platform defaults while keeping the font selectable in Settings.
const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
const isMac = /Macintosh|Mac OS X/.test(userAgent);
const isWindows = /Windows/.test(userAgent);

export const DEFAULT_EDITOR_FONT_FAMILY = isMac
  ? "'SF Mono', Menlo, Monaco, 'Courier New', monospace"
  : isWindows
    ? "'Cascadia Code', Consolas, 'Segoe UI Mono', 'Courier New', monospace"
    : "'Fira Code', 'JetBrains Mono', 'Liberation Mono', 'DejaVu Sans Mono', monospace";

export const DEFAULT_EDITOR_FONT_OPTIONS = {
  fontSize: isMac ? 12 : 14,
  fontWeight: "normal",
  fontLigatures: false,
  lineHeight: 0,
  letterSpacing: 0,
} as const;
