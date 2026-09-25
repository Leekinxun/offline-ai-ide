import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OpenFile } from "../types";
import {
  X,
  ChevronDown,
  Copy,
  FileCode2,
  Layers,
  ArrowRightToLine,
  XCircle,
} from "lucide-react";
import { useI18n } from "../i18n";
import "./TabBar.css";

interface TabBarProps {
  openFiles: OpenFile[];
  activeFilePath: string | null;
  workspaceDir?: string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onCloseOtherTabs?: (path: string) => void;
  onCloseTabsToTheRight?: (path: string) => void;
  onCloseAllTabs?: () => void;
  onShowToast?: (msg: string) => void;
}

interface TabContextMenuState {
  x: number;
  y: number;
  path: string;
}

export const TabBar: React.FC<TabBarProps> = ({
  openFiles,
  activeFilePath,
  workspaceDir,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToTheRight,
  onCloseAllTabs,
  onShowToast,
}) => {
  const { t } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);
  const [openEditorsOpen, setOpenEditorsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 规范化文件路径（剔除 Windows 斜杠及前导点杠差异）
  const normalizePath = useCallback((p: string) => {
    return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  }, []);

  // 渲染保护：对传入的 openFiles 做规范化去重兜底，杜绝重复 key 导致 React 僵尸 DOM
  const uniqueOpenFiles = useMemo(() => {
    const seen = new Set<string>();
    const result: OpenFile[] = [];
    for (const file of openFiles) {
      const key = normalizePath(file.path).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(file);
      }
    }
    return result;
  }, [openFiles, normalizePath]);

  // 计算同名文件的路径歧义消除标签（如 utils/index.ts vs hooks/index.ts）
  const pathLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const file of uniqueOpenFiles) {
      const peers = uniqueOpenFiles.filter((candidate) => candidate.name === file.name);
      if (peers.length < 2) continue;
      const parentParts = file.path.split("/").slice(0, -1);
      for (let depth = 1; depth <= parentParts.length; depth += 1) {
        const suffix = parentParts.slice(-depth).join("/");
        const unique = peers.every((candidate) => {
          if (candidate.path === file.path) return true;
          const candidateParent = candidate.path.split("/").slice(0, -1);
          return candidateParent.slice(-depth).join("/") !== suffix;
        });
        if (unique) {
          labels.set(file.path, suffix);
          break;
        }
      }
    }
    return labels;
  }, [uniqueOpenFiles]);

  // 当活动文件变更时，平滑滚动至当前标签，确保标签居中在视野内
  useEffect(() => {
    if (!activeFilePath) return;
    const activeIndex = uniqueOpenFiles.findIndex(
      (f) => normalizePath(f.path).toLowerCase() === normalizePath(activeFilePath).toLowerCase()
    );
    if (activeIndex >= 0 && tabRefs.current[activeIndex]) {
      tabRefs.current[activeIndex]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [activeFilePath, uniqueOpenFiles, normalizePath]);

  // 鼠标滚轮横向平滑滚动支持（将纵向 deltaY 转为横向 scrollLeft）
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!scrollContainerRef.current) return;
    if (e.deltaY !== 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      scrollContainerRef.current.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, []);

  // 监听全局点击与 Escape 键以关闭右键菜单和下拉清单
  useEffect(() => {
    if (!contextMenu && !openEditorsOpen) return;

    const handleDismiss = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") {
          setContextMenu(null);
          setOpenEditorsOpen(false);
        }
        return;
      }
      if (
        (dropdownRef.current && dropdownRef.current.contains(e.target as Node)) ||
        (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node))
      ) {
        return;
      }
      setContextMenu(null);
      setOpenEditorsOpen(false);
    };

    window.addEventListener("mousedown", handleDismiss);
    window.addEventListener("keydown", handleDismiss);
    return () => {
      window.removeEventListener("mousedown", handleDismiss);
      window.removeEventListener("keydown", handleDismiss);
    };
  }, [contextMenu, openEditorsOpen]);

  // 鼠标中键（滚轮点击）一键关闭标签
  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, path: string) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        onCloseTab(path);
      }
    },
    [onCloseTab]
  );

  // 标签右键菜单触发
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      e.preventDefault();
      e.stopPropagation();
      setOpenEditorsOpen(false);
      // 防止菜单超出右侧或底部视口边界
      const menuWidth = 190;
      const menuHeight = 220;
      const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
      const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
      setContextMenu({ x, y, path });
    },
    []
  );

  // 复制路径
  const handleCopyPath = useCallback(
    async (targetPath: string, full: boolean) => {
      const textToCopy = full
        ? workspaceDir
          ? `${workspaceDir.replace(/[\\/]+$/, "")}/${targetPath}`
          : targetPath
        : targetPath;
      try {
        await navigator.clipboard.writeText(textToCopy);
        onShowToast?.(full ? t("tabs.copiedPath") : t("tabs.copiedPath"));
      } catch {
        // fallback
      }
      setContextMenu(null);
    },
    [onShowToast, t, workspaceDir]
  );

  if (uniqueOpenFiles.length === 0) return null;

  const contextTargetIndex = contextMenu
    ? uniqueOpenFiles.findIndex((f) => normalizePath(f.path).toLowerCase() === normalizePath(contextMenu.path).toLowerCase())
    : -1;
  const canCloseRight = contextTargetIndex >= 0 && contextTargetIndex < uniqueOpenFiles.length - 1;
  const canCloseOthers = uniqueOpenFiles.length > 1;

  return (
    <div className="tabbar-container">
      <div
        ref={scrollContainerRef}
        className="tabbar"
        role="tablist"
        aria-label="Open files"
        onWheel={handleWheel}
      >
        {uniqueOpenFiles.map((file, index) => {
          const isActive = normalizePath(file.path).toLowerCase() === normalizePath(activeFilePath || "").toLowerCase();
          return (
            <div
              key={file.path}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              className={`tab${isActive ? " active" : ""}${file.modified ? " modified" : ""}`}
              onClick={() => onSelectTab(file.path)}
              onMouseDown={(e) => handleTabMouseDown(e, file.path)}
              onContextMenu={(e) => handleContextMenu(e, file.path)}
              role="tab"
              aria-selected={isActive}
              title={file.path}
              tabIndex={isActive ? 0 : -1}
              aria-label={`${file.name}${file.modified ? `, ${t("tabs.unsaved")}` : ""}${file.remoteUpdated ? `, ${t("tabs.remoteUpdated")}` : ""}`}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectTab(file.path);
                  return;
                }
                let nextIndex: number | null = null;
                if (event.key === "ArrowRight") nextIndex = (index + 1) % uniqueOpenFiles.length;
                if (event.key === "ArrowLeft") nextIndex = (index - 1 + uniqueOpenFiles.length) % uniqueOpenFiles.length;
                if (event.key === "Home") nextIndex = 0;
                if (event.key === "End") nextIndex = uniqueOpenFiles.length - 1;
                if (nextIndex !== null) {
                  event.preventDefault();
                  const nextFile = uniqueOpenFiles[nextIndex];
                  onSelectTab(nextFile.path);
                  window.requestAnimationFrame(() => tabRefs.current[nextIndex!]?.focus());
                  return;
                }
                if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  onCloseTab(file.path);
                  const focusIndex = Math.min(index, uniqueOpenFiles.length - 2);
                  if (focusIndex >= 0) {
                    window.requestAnimationFrame(() => tabRefs.current[focusIndex]?.focus());
                  }
                }
              }}
            >
              <FileCode2 size={13} className="tab-icon" />
              <span className="tab-label">
                <span className="tab-name">{file.name}</span>
                {pathLabels.get(file.path) && <span className="tab-path">{pathLabels.get(file.path)}</span>}
              </span>
              <div className="tab-trailing">
                {file.modified && <span className="tab-modified" title={t("tabs.unsaved")} />}
                {file.remoteUpdated && <span className="tab-remote-updated" title={t("tabs.remoteUpdated")} />}
                <button
                  type="button"
                  className="tab-close"
                  aria-label={t("tabs.close", { name: file.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(file.path);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 标签栏右侧功能区：已打开编辑器快捷清单 */}
      <div className="tabbar-actions" ref={dropdownRef}>
        <button
          type="button"
          className={`tabbar-action-btn${openEditorsOpen ? " active" : ""}`}
          title={`${t("tabs.openEditors")} (${uniqueOpenFiles.length})`}
          aria-label={t("tabs.openEditors")}
          aria-expanded={openEditorsOpen}
          onClick={() => {
            setContextMenu(null);
            setOpenEditorsOpen((prev) => !prev);
          }}
        >
          <ChevronDown size={14} className={`tabbar-chevron${openEditorsOpen ? " open" : ""}`} />
        </button>

        {/* 已打开文件下拉列表 */}
        {openEditorsOpen && (
          <div className="tabbar-dropdown panel-shell" role="menu">
            <div className="tabbar-dropdown-header">
              <span>{t("tabs.openEditors")}</span>
              <span className="tabbar-dropdown-count">{uniqueOpenFiles.length}</span>
              {onCloseAllTabs && uniqueOpenFiles.length > 1 && (
                <button
                  type="button"
                  className="tabbar-dropdown-close-all"
                  onClick={() => {
                    setOpenEditorsOpen(false);
                    onCloseAllTabs();
                  }}
                  title={t("tabs.closeAll")}
                >
                  {t("tabs.closeAll")}
                </button>
              )}
            </div>
            <div className="tabbar-dropdown-list">
              {uniqueOpenFiles.map((file) => {
                const isActive = normalizePath(file.path).toLowerCase() === normalizePath(activeFilePath || "").toLowerCase();
                return (
                  <div
                    key={file.path}
                    className={`tabbar-dropdown-item${isActive ? " active" : ""}`}
                    onClick={() => {
                      onSelectTab(file.path);
                      setOpenEditorsOpen(false);
                    }}
                    role="menuitem"
                  >
                    <FileCode2 size={13} className="tabbar-dropdown-icon" />
                    <span className="tabbar-dropdown-name" title={file.path}>
                      {file.name}
                    </span>
                    {pathLabels.get(file.path) && (
                      <span className="tabbar-dropdown-path">
                        {pathLabels.get(file.path)}
                      </span>
                    )}
                    {file.modified && <span className="tab-modified" title={t("tabs.unsaved")} />}
                    <button
                      type="button"
                      className="tabbar-dropdown-item-close"
                      title={t("tabs.close", { name: file.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(file.path);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 标签右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="tab-context-menu panel-shell"
          style={{
            position: "fixed",
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            zIndex: 1000,
          }}
          role="menu"
        >
          <button
            type="button"
            className="tab-context-item"
            onClick={() => {
              onCloseTab(contextMenu.path);
              setContextMenu(null);
            }}
          >
            <X size={13} />
            <span>{t("common.close")}</span>
          </button>
          <button
            type="button"
            className="tab-context-item"
            disabled={!canCloseOthers}
            onClick={() => {
              onCloseOtherTabs?.(contextMenu.path);
              setContextMenu(null);
            }}
          >
            <XCircle size={13} />
            <span>{t("tabs.closeOther")}</span>
          </button>
          <button
            type="button"
            className="tab-context-item"
            disabled={!canCloseRight}
            onClick={() => {
              onCloseTabsToTheRight?.(contextMenu.path);
              setContextMenu(null);
            }}
          >
            <ArrowRightToLine size={13} />
            <span>{t("tabs.closeRight")}</span>
          </button>
          <button
            type="button"
            className="tab-context-item"
            onClick={() => {
              onCloseAllTabs?.();
              setContextMenu(null);
            }}
          >
            <XCircle size={13} />
            <span>{t("tabs.closeAll")}</span>
          </button>
          <div className="tab-context-divider" />
          <button
            type="button"
            className="tab-context-item"
            onClick={() => void handleCopyPath(contextMenu.path, false)}
          >
            <Copy size={13} />
            <span>{t("tabs.copyRelativePath")}</span>
          </button>
          <button
            type="button"
            className="tab-context-item"
            onClick={() => void handleCopyPath(contextMenu.path, true)}
          >
            <Copy size={13} />
            <span>{t("tabs.copyPath")}</span>
          </button>
        </div>
      )}
    </div>
  );
};
