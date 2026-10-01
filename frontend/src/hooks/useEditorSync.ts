import React, { useEffect, useRef } from "react";
import type * as monaco from "monaco-editor";
import { OpenFile, SelectionInfo } from "../types";
import { FilePreviewMode } from "../plugins/types";
import { useTeam } from "./useTeam";
import { useChat } from "./useChat";

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface UseEditorSyncOptions {
  activeFile: OpenFile | null;
  readOnlyWorkspace: boolean;
  team: ReturnType<typeof useTeam>;
  chat: ReturnType<typeof useChat>;
  selectionInfo: SelectionInfo | null;
  showToast: (msg: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  compareEditorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  previewPaneRef: React.RefObject<HTMLDivElement | null>;
  compareFile: OpenFile | null;
  compareScrollLinked: boolean;
  compareEditorMountVersion: number;
  activePreviewMode: FilePreviewMode;
}

/**
 * 编辑器多端协同缓冲、上下文摘要实时同步与双栏/对比分屏滚动镜射 Hook
 */
export function useEditorSync(options: UseEditorSyncOptions): void {
  const {
    activeFile,
    readOnlyWorkspace,
    team,
    chat,
    selectionInfo,
    showToast,
    t,
    editorRef,
    compareEditorRef,
    previewPaneRef,
    compareFile,
    compareScrollLinked,
    compareEditorMountVersion,
    activePreviewMode,
  } = options;

  const savedBufferContentRef = useRef<Record<string, string>>({});
  const collaborationBufferVersionRef = useRef<Record<string, number>>({});
  const isSyncingScrollRef = useRef<"editor" | "preview" | null>(null);
  const syncScrollTimerRef = useRef<number | null>(null);

  // 1. 多人协同 Buffer 注册与防抖同步
  useEffect(() => {
    if (!activeFile || readOnlyWorkspace || !activeFile.version) return;
    if (!activeFile.modified) {
      savedBufferContentRef.current[activeFile.path] = activeFile.content;
      const registeredVersion = collaborationBufferVersionRef.current[activeFile.path];
      if (registeredVersion !== undefined) {
        team.closeBuffer(activeFile.path, registeredVersion);
        delete collaborationBufferVersionRef.current[activeFile.path];
      }
      return;
    }
    const savedContent = savedBufferContentRef.current[activeFile.path];
    if (savedContent === undefined) return;
    const timer = window.setTimeout(() => {
      const version = (collaborationBufferVersionRef.current[activeFile.path] || 0) + 1;
      void Promise.all([sha256Text(activeFile.content), sha256Text(savedContent)]).then(([digest, savedDigest]) => {
        if (team.registerBuffer({ path: activeFile.path, version, digest, savedDigest, baseDigest: savedDigest, revision: activeFile.version! })) {
          collaborationBufferVersionRef.current[activeFile.path] = version;
        }
      }).catch((reason) => showToast(reason instanceof Error ? reason.message : t("collaboration.bufferFailed")));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeFile?.content, activeFile?.modified, activeFile?.path, activeFile?.version, readOnlyWorkspace, showToast, t, team]);

  // 2. AI 上下文 Manifest 实时预览更新
  useEffect(() => {
    if (!activeFile) return;
    const timer = window.setTimeout(() => {
      void chat.contextManifest.preview({
        path: activeFile.path,
        content: activeFile.content,
        language: activeFile.language,
        selection: selectionInfo?.text,
        dirty: activeFile.modified,
        selectionRange: selectionInfo
          ? { startLine: selectionInfo.startLine, endLine: selectionInfo.endLine }
          : undefined,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeFile?.language, activeFile?.modified, activeFile?.path, chat.contextManifest, selectionInfo?.endLine, selectionInfo?.startLine, selectionInfo?.text]);

  // 3. 对比编辑器滚动镜像绑定
  useEffect(() => {
    if (!compareFile || !compareScrollLinked) return;

    let disposed = false;
    let pollTimer: number | null = null;
    let primaryScroll: monaco.IDisposable | null = null;
    let referenceScroll: monaco.IDisposable | null = null;

    const expectedScroll = new Map<
      monaco.editor.IStandaloneCodeEditor,
      { scrollTop?: number; scrollLeft?: number }
    >();

    const mirrorScroll = (
      source: monaco.editor.IStandaloneCodeEditor,
      target: monaco.editor.IStandaloneCodeEditor,
      syncVertical: boolean,
      syncHorizontal: boolean
    ) => {
      const sourceLayout = source.getLayoutInfo();
      const targetLayout = target.getLayoutInfo();
      const sourceVerticalRange = Math.max(0, source.getScrollHeight() - sourceLayout.height);
      const targetVerticalRange = Math.max(0, target.getScrollHeight() - targetLayout.height);
      const sourceHorizontalRange = Math.max(0, source.getScrollWidth() - sourceLayout.contentWidth);
      const targetHorizontalRange = Math.max(0, target.getScrollWidth() - targetLayout.contentWidth);
      const position = {
        ...(syncVertical
          ? { scrollTop: sourceVerticalRange > 0
              ? (source.getScrollTop() / sourceVerticalRange) * targetVerticalRange
              : 0 }
          : {}),
        ...(syncHorizontal
          ? { scrollLeft: sourceHorizontalRange > 0
              ? (source.getScrollLeft() / sourceHorizontalRange) * targetHorizontalRange
              : 0 }
          : {}),
      };
      const changesVertical = position.scrollTop !== undefined &&
        Math.abs(position.scrollTop - target.getScrollTop()) > 0.5;
      const changesHorizontal = position.scrollLeft !== undefined &&
        Math.abs(position.scrollLeft - target.getScrollLeft()) > 0.5;
      if (!changesVertical && !changesHorizontal) return;
      expectedScroll.set(target, position);
      target.setScrollPosition(position);
    };

    const listen = (
      source: monaco.editor.IStandaloneCodeEditor,
      target: monaco.editor.IStandaloneCodeEditor
    ) => source.onDidScrollChange((event) => {
      const expected = expectedScroll.get(source);
      if (expected) {
        const matchesTop = expected.scrollTop === undefined || Math.abs(expected.scrollTop - event.scrollTop) <= 0.5;
        const matchesLeft = expected.scrollLeft === undefined || Math.abs(expected.scrollLeft - event.scrollLeft) <= 0.5;
        expectedScroll.delete(source);
        if (matchesTop && matchesLeft) return;
      }
      mirrorScroll(source, target, event.scrollTopChanged, event.scrollLeftChanged);
    });

    let attempts = 0;
    const tryAttach = () => {
      if (disposed) return;
      const primary = editorRef.current;
      const reference = compareEditorRef.current;
      if (!primary || !reference) {
        if (attempts++ < 30) {
          pollTimer = window.setTimeout(tryAttach, 60);
        }
        return;
      }
      primaryScroll = listen(primary, reference);
      referenceScroll = listen(reference, primary);
      mirrorScroll(primary, reference, true, true);
    };

    tryAttach();

    return () => {
      disposed = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      primaryScroll?.dispose();
      referenceScroll?.dispose();
    };
  }, [compareEditorMountVersion, compareEditorRef, compareFile, compareScrollLinked, editorRef]);

  // 4. 预览分栏模式双向同步滚动（支持 Markdown 与 JSON 视觉解析器，带挂载重试自愈）
  useEffect(() => {
    if (activePreviewMode !== "split" || !activeFile) {
      return;
    }

    let disposed = false;
    let pollTimer: number | null = null;
    let editorScrollDisposable: monaco.IDisposable | null = null;
    let attachedContainer: HTMLElement | null = null;
    let previewScrollHandler: ((e: Event) => void) | null = null;

    const clearSyncTimer = () => {
      if (syncScrollTimerRef.current !== null) {
        window.cancelAnimationFrame(syncScrollTimerRef.current);
        syncScrollTimerRef.current = null;
      }
    };

    const findScrollableElement = (container: HTMLElement): HTMLElement | null => {
      const candidates = [
        container.querySelector<HTMLElement>(".external-markdown-preview"),
        container.querySelector<HTMLElement>(".json-preview-tree"),
        container.querySelector<HTMLElement>("[data-scroll-container]"),
        container.querySelector<HTMLElement>(".file-preview-surface"),
      ];
      for (const el of candidates) {
        if (el && el.scrollHeight > el.clientHeight) return el;
      }
      const all = container.querySelectorAll<HTMLElement>("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.scrollHeight > el.clientHeight + 2) {
          const style = window.getComputedStyle(el);
          if (style.overflowY === "auto" || style.overflowY === "scroll") {
            return el;
          }
        }
      }
      if (container.scrollHeight > container.clientHeight) {
        return container;
      }
      return candidates.find(Boolean) || (container.firstElementChild as HTMLElement) || container;
    };

    let attempts = 0;
    const tryAttach = () => {
      if (disposed) return;
      const editor = editorRef.current;
      const previewContainer = previewPaneRef.current;

      if (!editor || !previewContainer) {
        if (attempts++ < 30) {
          pollTimer = window.setTimeout(tryAttach, 60);
        }
        return;
      }

      let scrollEl = findScrollableElement(previewContainer);

      // Monaco 编辑器滚动 -> 驱动预览侧滚动
      editorScrollDisposable = editor.onDidScrollChange((event) => {
        if (!event.scrollTopChanged) return;
        if (isSyncingScrollRef.current === "preview") return;

        if (!scrollEl || scrollEl.scrollHeight <= scrollEl.clientHeight) {
          scrollEl = findScrollableElement(previewContainer);
        }
        if (!scrollEl) return;

        const editorScrollable = editor.getScrollHeight() - editor.getLayoutInfo().height;
        const previewScrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
        if (editorScrollable <= 0 || previewScrollable <= 0) return;

        const ratio = editor.getScrollTop() / editorScrollable;
        const targetScrollTop = ratio * previewScrollable;

        if (Math.abs(scrollEl.scrollTop - targetScrollTop) > 1) {
          isSyncingScrollRef.current = "editor";
          scrollEl.scrollTop = targetScrollTop;
          clearSyncTimer();
          syncScrollTimerRef.current = window.requestAnimationFrame(() => {
            isSyncingScrollRef.current = null;
          });
        }
      });

      // 预览侧滚动 -> 驱动 Monaco 编辑器滚动
      const handlePreviewScroll = (e: Event) => {
        if (isSyncingScrollRef.current === "editor") return;
        const eventTarget = e.target as HTMLElement | null;
        if (!eventTarget || eventTarget === editor.getDomNode()?.parentElement) return;

        const target = (eventTarget.scrollHeight > eventTarget.clientHeight ? eventTarget : null)
          || scrollEl
          || findScrollableElement(previewContainer);
        if (!target) return;

        const previewScrollable = target.scrollHeight - target.clientHeight;
        const editorScrollable = editor.getScrollHeight() - editor.getLayoutInfo().height;
        if (previewScrollable <= 0 || editorScrollable <= 0) return;

        const ratio = target.scrollTop / previewScrollable;
        const targetScrollTop = ratio * editorScrollable;

        if (Math.abs(editor.getScrollTop() - targetScrollTop) > 1) {
          isSyncingScrollRef.current = "preview";
          editor.setScrollTop(targetScrollTop);
          clearSyncTimer();
          syncScrollTimerRef.current = window.requestAnimationFrame(() => {
            isSyncingScrollRef.current = null;
          });
        }
      };

      previewContainer.addEventListener("scroll", handlePreviewScroll, {
        capture: true,
        passive: true,
      });
      attachedContainer = previewContainer;
      previewScrollHandler = handlePreviewScroll;

      // 绑定成功后执行一次初始同步
      const initialScrollable = editor.getScrollHeight() - editor.getLayoutInfo().height;
      if (initialScrollable > 0 && scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight) {
        const ratio = editor.getScrollTop() / initialScrollable;
        scrollEl.scrollTop = ratio * (scrollEl.scrollHeight - scrollEl.clientHeight);
      }
    };

    tryAttach();

    return () => {
      disposed = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      editorScrollDisposable?.dispose();
      if (attachedContainer && previewScrollHandler) {
        attachedContainer.removeEventListener("scroll", previewScrollHandler, {
          capture: true,
        });
      }
      clearSyncTimer();
      isSyncingScrollRef.current = null;
    };
  }, [activeFile, activePreviewMode, compareEditorMountVersion, editorRef, previewPaneRef]);
}
