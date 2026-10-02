import React, { useState, useRef, useEffect, useCallback } from "react";

export const FILES_ACTIVITY_WIDTH = 56;
export const FILES_HANDLE_WIDTH = 6;
export const FILES_EDITOR_MIN_WIDTH = 360;
export const FILES_EDITOR_IDEAL_MIN_WIDTH = 500;
export const FILES_SIDEBAR_MIN_WIDTH = 180;
export const FILES_SIDEBAR_MAX_WIDTH = 500;
export const FILES_ASSISTANT_MIN_WIDTH = 280;
export const FILES_ASSISTANT_MAX_WIDTH = 720;

export interface PanelLayoutOptions {
  viewportWidth: number;
  isLeftDockOpen: boolean;
  runDetailsVisible: boolean;
  editorAssistantVisible: boolean;
  webPreviewVisible?: boolean;
  mainLayoutRef: React.RefObject<HTMLDivElement | null>;
}

export interface PanelLayoutReturn {
  sidebarWidth: number;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  assistantWidth: number;
  setAssistantWidth: React.Dispatch<React.SetStateAction<number>>;
  chatWidth: number;
  setChatWidth: React.Dispatch<React.SetStateAction<number>>;
  terminalHeight: number;
  setTerminalHeight: React.Dispatch<React.SetStateAction<number>>;
  draggingPanel: "sidebar" | "assistant" | "chat" | "terminal" | null;
  sidebarMaxWidth: number;
  assistantMaxWidth: number;
  effectiveSidebarWidth: number;
  fileDockWidth: number;
  chatDockWidth: number;
  effectiveAssistantWidth: number;
  handleResizeStart: (panel: "sidebar" | "assistant" | "chat", e: React.MouseEvent) => void;
  handlePanelResizeKeyDown: (panel: "sidebar" | "assistant", event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleTerminalResizeStart: (e: React.MouseEvent) => void;
  adjustTerminalHeight: (delta: number) => void;
  handleTerminalResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * 工作台各面板尺寸、拖拽伸缩与键盘快捷微调 Hook
 */
export function usePanelLayout(options: PanelLayoutOptions): PanelLayoutReturn {
  const {
    viewportWidth,
    isLeftDockOpen,
    runDetailsVisible,
    editorAssistantVisible,
    webPreviewVisible = false,
    mainLayoutRef,
  } = options;

  const [sidebarWidth, setSidebarWidth] = useState(286);
  const [assistantWidth, setAssistantWidth] = useState(400);
  const [draggingPanel, setDraggingPanel] = useState<"sidebar" | "assistant" | "chat" | "terminal" | null>(null);
  const [chatWidth, setChatWidth] = useState(380);
  const [terminalHeight, setTerminalHeight] = useState(260);

  const draggingRef = useRef<"sidebar" | "assistant" | "chat" | "terminal" | null>(null);
  const panelWidthsRef = useRef({ sidebar: sidebarWidth, assistant: assistantWidth });
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startWidthRef = useRef(0);
  const startHeightRef = useRef(0);

  // 媒体查询响应式预算计算
  const layoutAvailableWidth = Math.min(
    viewportWidth,
    (typeof document !== "undefined" && document.documentElement.clientWidth) || viewportWidth
  );
  const isLaptopOrCompact = viewportWidth < 1440;
  const responsiveDefaultSidebarWidth = isLaptopOrCompact ? Math.min(sidebarWidth, 240) : sidebarWidth;
  const responsiveDefaultAssistantWidth = isLaptopOrCompact ? Math.min(assistantWidth, 340) : assistantWidth;

  const dockedRightWidth = viewportWidth > 1180
    ? webPreviewVisible
      ? Math.max(400, responsiveDefaultAssistantWidth)
      : runDetailsVisible
        ? (isLaptopOrCompact ? 340 : 400)
        : editorAssistantVisible
          ? responsiveDefaultAssistantWidth
          : 0
    : 0;

  // 黄金编辑区保底空间：大屏保留 520px，中屏保留 460px，紧凑模式保留至少 360px
  const reservedEditorBudget = viewportWidth > 1440 ? 520 : viewportWidth > 1180 ? 460 : FILES_EDITOR_MIN_WIDTH;

  const sidebarMaxWidth = Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(
    FILES_SIDEBAR_MAX_WIDTH,
    layoutAvailableWidth - FILES_ACTIVITY_WIDTH - FILES_HANDLE_WIDTH
      - (dockedRightWidth ? dockedRightWidth + FILES_HANDLE_WIDTH : 0)
      - reservedEditorBudget
  ));
  const effectiveSidebarWidth = isLeftDockOpen ? Math.min(responsiveDefaultSidebarWidth, sidebarMaxWidth) : 0;
  const fileDockWidth = effectiveSidebarWidth;
  const chatDockWidth = isLeftDockOpen ? (isLaptopOrCompact ? 250 : effectiveSidebarWidth) : 0;
  const assistantMaxWidth = viewportWidth > 1180
    ? Math.max(FILES_ASSISTANT_MIN_WIDTH, Math.min(
        FILES_ASSISTANT_MAX_WIDTH,
        layoutAvailableWidth - FILES_ACTIVITY_WIDTH
          - fileDockWidth - (isLeftDockOpen ? FILES_HANDLE_WIDTH : 0)
          - FILES_HANDLE_WIDTH - reservedEditorBudget
      ))
    : Math.min(FILES_ASSISTANT_MAX_WIDTH, Math.max(FILES_ASSISTANT_MIN_WIDTH, layoutAvailableWidth - FILES_ACTIVITY_WIDTH));
  const effectiveAssistantWidth = Math.min(responsiveDefaultAssistantWidth, assistantMaxWidth);
  panelWidthsRef.current = { sidebar: fileDockWidth, assistant: effectiveAssistantWidth };

  // 拖拽启动
  const handleResizeStart = useCallback(
    (panel: "sidebar" | "assistant" | "chat", e: React.MouseEvent) => {
      if (e.button !== 0 || viewportWidth <= 780) return;
      e.preventDefault();
      draggingRef.current = panel;
      setDraggingPanel(panel);
      startXRef.current = e.clientX;
      startWidthRef.current = panel === "sidebar"
        ? effectiveSidebarWidth
        : panel === "assistant" ? effectiveAssistantWidth : chatWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [chatWidth, effectiveAssistantWidth, effectiveSidebarWidth, viewportWidth]
  );

  // 键盘无障碍调整侧边栏/助手宽度
  const handlePanelResizeKeyDown = useCallback((panel: "sidebar" | "assistant", event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16;
    let next: number;
    if (event.key === "Home") next = panel === "sidebar" ? FILES_SIDEBAR_MIN_WIDTH : FILES_ASSISTANT_MIN_WIDTH;
    else if (event.key === "End") next = panel === "sidebar" ? sidebarMaxWidth : assistantMaxWidth;
    else if (event.key === "ArrowLeft") next = panel === "sidebar" ? effectiveSidebarWidth - step : effectiveAssistantWidth + step;
    else if (event.key === "ArrowRight") next = panel === "sidebar" ? effectiveSidebarWidth + step : effectiveAssistantWidth - step;
    else return;
    event.preventDefault();
    if (panel === "sidebar") {
      setSidebarWidth(Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(sidebarMaxWidth, next)));
    } else {
      setAssistantWidth(Math.max(FILES_ASSISTANT_MIN_WIDTH, Math.min(assistantMaxWidth, next)));
    }
  }, [assistantMaxWidth, effectiveAssistantWidth, effectiveSidebarWidth, sidebarMaxWidth]);

  // 终端高度拖拽
  const handleTerminalResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = "terminal";
      setDraggingPanel("terminal");
      startYRef.current = e.clientY;
      startHeightRef.current = terminalHeight;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [terminalHeight]
  );

  const adjustTerminalHeight = useCallback((delta: number) => {
    const maxHeight = Math.max(260, Math.min(680, window.innerHeight - 140));
    setTerminalHeight((height) => Math.max(160, Math.min(maxHeight, height + delta)));
  }, []);

  const handleTerminalResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        adjustTerminalHeight(24);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        adjustTerminalHeight(-24);
      } else if (event.key === "Home") {
        event.preventDefault();
        setTerminalHeight(160);
      } else if (event.key === "End") {
        event.preventDefault();
        setTerminalHeight(Math.max(260, Math.min(680, window.innerHeight - 140)));
      }
    },
    [adjustTerminalHeight]
  );

  // 全局鼠标拖拽监听与释放
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      if (draggingRef.current === "sidebar") {
        const layout = mainLayoutRef.current;
        const width = layout?.clientWidth || window.innerWidth;
        const rightWidth = window.innerWidth > 1180 && (layout?.classList.contains("with-run-details") || layout?.classList.contains("with-editor-assistant"))
          ? panelWidthsRef.current.assistant
          : 0;
        const maxWidth = Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(
          FILES_SIDEBAR_MAX_WIDTH,
          width - FILES_ACTIVITY_WIDTH - FILES_HANDLE_WIDTH
            - (rightWidth ? rightWidth + FILES_HANDLE_WIDTH : 0)
            - FILES_EDITOR_MIN_WIDTH
        ));
        setSidebarWidth(Math.max(FILES_SIDEBAR_MIN_WIDTH, Math.min(maxWidth, startWidthRef.current + delta)));
      } else if (draggingRef.current === "assistant") {
        const width = mainLayoutRef.current?.clientWidth || window.innerWidth;
        const maxWidth = window.innerWidth > 1180
          ? Math.max(FILES_ASSISTANT_MIN_WIDTH, Math.min(
              FILES_ASSISTANT_MAX_WIDTH,
              width - FILES_ACTIVITY_WIDTH
                - (panelWidthsRef.current.sidebar ? panelWidthsRef.current.sidebar + FILES_HANDLE_WIDTH : 0)
                - FILES_HANDLE_WIDTH - FILES_EDITOR_MIN_WIDTH
            ))
          : Math.min(FILES_ASSISTANT_MAX_WIDTH, Math.max(FILES_ASSISTANT_MIN_WIDTH, width - FILES_ACTIVITY_WIDTH));
        setAssistantWidth(Math.max(FILES_ASSISTANT_MIN_WIDTH, Math.min(maxWidth, startWidthRef.current - delta)));
      } else if (draggingRef.current === "chat") {
        setChatWidth(Math.max(250, Math.min(600, startWidthRef.current - delta)));
      } else {
        const verticalDelta = startYRef.current - e.clientY;
        const maxHeight = Math.max(260, Math.min(680, window.innerHeight - 140));
        setTerminalHeight(
          Math.max(160, Math.min(maxHeight, startHeightRef.current + verticalDelta))
        );
      }
    };
    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      setDraggingPanel(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onMouseUp);
    };
  }, [mainLayoutRef]);

  return {
    sidebarWidth,
    setSidebarWidth,
    assistantWidth,
    setAssistantWidth,
    chatWidth,
    setChatWidth,
    terminalHeight,
    setTerminalHeight,
    draggingPanel,
    sidebarMaxWidth,
    assistantMaxWidth,
    effectiveSidebarWidth,
    fileDockWidth,
    chatDockWidth,
    effectiveAssistantWidth,
    handleResizeStart,
    handlePanelResizeKeyDown,
    handleTerminalResizeStart,
    adjustTerminalHeight,
    handleTerminalResizeKeyDown,
  };
}
