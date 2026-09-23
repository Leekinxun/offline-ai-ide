// Match VS Code's platform defaults while keeping the font selectable in Settings.
const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
const isMac = /Macintosh|Mac OS X/.test(userAgent);
const isWindows = /Windows/.test(userAgent);

export const DEFAULT_EDITOR_FONT_FAMILY = isMac
  ? "Menlo, Monaco, 'Courier New', monospace"
  : isWindows
    ? "Consolas, 'Courier New', monospace"
    : "'Droid Sans Mono', monospace";

export const DEFAULT_EDITOR_FONT_OPTIONS = {
  fontSize: isMac ? 12 : 14,
  fontWeight: "normal",
  fontLigatures: false,
  lineHeight: 0,
  letterSpacing: 0,
} as const;
