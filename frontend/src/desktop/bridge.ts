export interface DesktopPreferences {
  theme?: "light" | "dark";
  editorFont?: string;
  zoomLevel?: number;
  locale?: string;
}

export type DesktopZoomCommand = "in" | "out" | "reset";

export interface DesktopBridge {
  platform: string;
  version: string;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(patch: DesktopPreferences): Promise<DesktopPreferences>;
  openExternal(url: string): Promise<boolean>;
  onZoomCommand(callback: (command: DesktopZoomCommand) => void): () => void;
  switchServer?(): Promise<boolean>;
  getServerUrl?(): Promise<string>;
}

declare global {
  interface Window {
    crownforgeDesktop?: DesktopBridge;
  }
}

export function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.crownforgeDesktop;
}
