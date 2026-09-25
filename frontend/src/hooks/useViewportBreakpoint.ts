import { useState, useEffect } from "react";

export type BreakpointCategory = "compact" | "laptop" | "desktop" | "ultrawide";
export type LayoutDensity = "normal" | "compact";

export interface ViewportBreakpointState {
  width: number;
  height: number;
  breakpoint: BreakpointCategory;
  isCompactWidth: boolean;
  isShortHeight: boolean;
  recommendedDensity: LayoutDensity;
}

function getBreakpointCategory(width: number): BreakpointCategory {
  if (width < 1024) return "compact";
  if (width < 1440) return "laptop";
  if (width <= 1920) return "desktop";
  return "ultrawide";
}

function getViewportState(): ViewportBreakpointState {
  if (typeof window === "undefined") {
    return {
      width: 1440,
      height: 900,
      breakpoint: "laptop",
      isCompactWidth: false,
      isShortHeight: false,
      recommendedDensity: "normal",
    };
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  const breakpoint = getBreakpointCategory(width);
  const isCompactWidth = width < 1200;
  const isShortHeight = height < 750;
  const recommendedDensity: LayoutDensity = (isShortHeight || width < 1200) ? "compact" : "normal";

  return {
    width,
    height,
    breakpoint,
    isCompactWidth,
    isShortHeight,
    recommendedDensity,
  };
}

/**
 * 视口与分辨率感知 Hook：防抖监听视口尺寸，计算断点与紧凑度推荐
 */
export function useViewportBreakpoint(): ViewportBreakpointState {
  const [viewport, setViewport] = useState<ViewportBreakpointState>(getViewportState);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setViewport(getViewportState());
      }, 100);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return viewport;
}
