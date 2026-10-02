import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "user-zoom-level";
const DEFAULT_ZOOM = 1.0;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.6;
const ZOOM_STEP = 0.1;

export const ZOOM_PRESET_OPTIONS = [
  { value: 0.8, label: "80% (紧凑小屏)" },
  { value: 0.9, label: "90% (轻度缩减)" },
  { value: 1.0, label: "100% (默认标准)" },
  { value: 1.1, label: "110% (舒适稍大)" },
  { value: 1.2, label: "120% (放大)" },
  { value: 1.3, label: "130% (高分屏 2.5K/4K)" },
  { value: 1.4, label: "140% (超大)" },
  { value: 1.5, label: "150% (特大)" },
];

/**
 * 全局比例缩放管理 Hook：
 * 采用全局布局比例缩放（Layout Zoom），统一控制全屏界面（含所有面板、字体、间距、画布）
 * 支持快捷键 Ctrl/Cmd + = (放大), Ctrl/Cmd + - (缩小), Ctrl/Cmd + 0 (重置 100%)
 */
export function useGlobalZoom(showToast?: (msg: string) => void) {
  const [zoomLevel, setZoomLevelState] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const val = parseFloat(saved);
        if (!isNaN(val) && val >= MIN_ZOOM && val <= MAX_ZOOM) {
          return Math.round(val * 100) / 100;
        }
      }
    } catch {}
    return DEFAULT_ZOOM;
  });

  const applyZoom = useCallback((level: number, notify = false) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(level * 100) / 100));
    setZoomLevelState(clamped);
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {}
    document.documentElement.style.zoom = String(clamped);

    // 触发全局 resize 事件以通知 Monaco Editor、Xterm 及响应式断点即时重绘
    window.dispatchEvent(new Event("resize"));

    if (notify && showToast) {
      const percent = Math.round(clamped * 100);
      showToast(clamped === 1.0 ? "界面缩放已重置 (100%)" : `界面缩放: ${percent}%`);
    }
  }, [showToast]);

  // 初始加载时应用缩放
  useEffect(() => {
    document.documentElement.style.zoom = String(zoomLevel);
  }, [zoomLevel]);

  const zoomIn = useCallback(() => {
    applyZoom(zoomLevel + ZOOM_STEP, true);
  }, [zoomLevel, applyZoom]);

  const zoomOut = useCallback(() => {
    applyZoom(zoomLevel - ZOOM_STEP, true);
  }, [zoomLevel, applyZoom]);

  const resetZoom = useCallback(() => {
    applyZoom(DEFAULT_ZOOM, true);
  }, [applyZoom]);

  const setZoom = useCallback((level: number) => {
    applyZoom(level, true);
  }, [applyZoom]);

  // 快捷键全局监听: Ctrl/Cmd + '=', Ctrl/Cmd + '-', Ctrl/Cmd + '0'
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;

      if (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        resetZoom();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [zoomIn, zoomOut, resetZoom]);

  return {
    zoomLevel,
    zoomPercent: Math.round(zoomLevel * 100),
    zoomIn,
    zoomOut,
    resetZoom,
    setZoom,
  };
}
