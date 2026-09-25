import { useMemo } from "react";

export type OperatingSystem = "windows" | "linux" | "macos" | "unknown";
export type PlatformHost = "desktop" | "web";

export interface PlatformEnvironment {
  os: OperatingSystem;
  host: PlatformHost;
  isDesktop: boolean;
  isWeb: boolean;
  isWindows: boolean;
  isLinux: boolean;
  isMacOS: boolean;
  modifierKey: "Ctrl" | "⌘";
  modifierSymbol: "Ctrl" | "⌘";
  altKey: "Alt" | "⌥";
}

/**
 * 检测当前客户端宿主环境的操作系统
 */
function detectOS(): OperatingSystem {
  if (typeof window === "undefined" || !window.navigator) {
    return "unknown";
  }

  const userAgent = (window.navigator.userAgent || "").toLowerCase();
  const platform = (window.navigator.platform || "").toLowerCase();

  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows";
  }
  if (platform.includes("mac") || userAgent.includes("macintosh") || userAgent.includes("mac os")) {
    return "macos";
  }
  if (platform.includes("linux") || platform.includes("x11") || userAgent.includes("linux")) {
    return "linux";
  }

  return "unknown";
}

/**
 * 检测是否处于 Electron 桌面端原生容器
 */
function detectIsDesktop(isDesktopProp?: boolean): boolean {
  if (typeof isDesktopProp === "boolean") {
    return isDesktopProp;
  }
  if (typeof window === "undefined" || !window.navigator) {
    return false;
  }

  const userAgent = window.navigator.userAgent || "";
  // Electron 默认会在 userAgent 中注入 "Electron"
  const hasElectronUserAgent = /electron/i.test(userAgent);
  // 或者 window.process 具有 type
  const hasProcessElectron = Boolean((window as unknown as { process?: { versions?: { electron?: string } } }).process?.versions?.electron);

  return hasElectronUserAgent || hasProcessElectron;
}

/**
 * 平台环境感知 Hook：统一检测当前操作系统、宿主模式与系统快捷键语义
 */
export function usePlatformEnvironment(isDesktopOverride?: boolean): PlatformEnvironment {
  return useMemo(() => {
    const os = detectOS();
    const isDesktop = detectIsDesktop(isDesktopOverride);
    const host: PlatformHost = isDesktop ? "desktop" : "web";
    const isWindows = os === "windows";
    const isLinux = os === "linux";
    const isMacOS = os === "macos";

    const isApple = isMacOS;
    const modifierKey = isApple ? "⌘" : "Ctrl";
    const modifierSymbol = isApple ? "⌘" : "Ctrl";
    const altKey = isApple ? "⌥" : "Alt";

    return {
      os,
      host,
      isDesktop,
      isWeb: !isDesktop,
      isWindows,
      isLinux,
      isMacOS,
      modifierKey,
      modifierSymbol,
      altKey,
    };
  }, [isDesktopOverride]);
}
