import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject } from "react";
import { VirtualizedFileDiff } from "@pierre/diffs";
import { MultiFileDiff, Virtualizer, useVirtualizer, type DiffFileInput, type FileDiffOptions, type SelectedLineRange, type VirtualFileMetrics } from "@pierre/diffs/react";
import { DEFAULT_EDITOR_FONT_FAMILY, DEFAULT_EDITOR_FONT_OPTIONS } from "../editor/fontDefaults";
import { getDiffLineRevealScrollTop, toReviewLineSelection, type ReviewLineSelection } from "./pierreDiffPolicy";
import "./PierreDiff.css";

interface PierreDiffProps {
  path: string;
  original: string;
  modified: string;
  originalExists?: boolean;
  modifiedExists?: boolean;
  theme: "light" | "dark";
  layout?: "split" | "unified";
  fontFamily?: string;
  onSelection?: (selection: ReviewLineSelection) => void;
}

const THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;
const FONT_SIZE = DEFAULT_EDITOR_FONT_OPTIONS.fontSize;
const LINE_HEIGHT = Math.round(FONT_SIZE * 1.6);
const METRICS: VirtualFileMetrics = {
  hunkLineCount: 50,
  lineHeight: LINE_HEIGHT,
  diffHeaderHeight: 0,
  spacing: 8,
};

interface DiffView {
  container: HTMLElement;
  instance: VirtualizedFileDiff;
  virtualizer: NonNullable<ReturnType<typeof useVirtualizer>>;
}

function DiffCanvas({ files, options, selectedLines, view }: {
  files: DiffFileInput;
  options: FileDiffOptions<undefined, undefined>;
  selectedLines: SelectedLineRange | null;
  view: MutableRefObject<DiffView | null>;
}) {
  const virtualizer = useVirtualizer();
  const canvasOptions = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    ...options,
    onPostRender: (container, instance, phase) => {
      if (phase === "unmount") {
        if (view.current?.container === container) view.current = null;
      } else if (virtualizer && instance instanceof VirtualizedFileDiff) {
        view.current = { container, instance, virtualizer };
      }
      options.onPostRender?.(container, instance, phase);
    },
  }), [options, view, virtualizer]);
  return <MultiFileDiff {...files} options={canvasOptions} metrics={METRICS} selectedLines={selectedLines} />;
}

function selectionPoint(node: Node | null): { line: number; side: "additions" | "deletions" } | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const line = element?.closest("[data-line]");
  if (!line) return null;
  const type = line.getAttribute("data-line-type");
  const side = type === "change-deletion" || line.closest("[data-deletions]") ? "deletions" : "additions";
  return { line: Number(line.getAttribute("data-line")), side };
}

/** Read-only rendering only: decisions still use the server's revision and mutation identities. */
export default function PierreDiff({ path, original, modified, originalExists = true, modifiedExists = true,
  theme, layout = "split", fontFamily = DEFAULT_EDITOR_FONT_FAMILY, onSelection }: PierreDiffProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DiffView | null>(null);
  const selectionCleanup = useRef(new Map<HTMLElement, () => void>());
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const files = useMemo<DiffFileInput>(() => {
    const oldFile = { name: path, contents: original };
    const newFile = { name: path, contents: modified };
    if (!originalExists) return { oldFile: null, newFile };
    if (!modifiedExists) return { oldFile, newFile: null };
    return { oldFile, newFile };
  }, [path, original, modified, originalExists, modifiedExists]);
  const lineCounts = useMemo(() => ({ additions: modified.split(/\r\n|\r|\n/).length,
    deletions: original.split(/\r\n|\r|\n/).length }), [original, modified]);

  useEffect(() => { setSelectedLines(null); }, [files]);

  const selectLines = useCallback((range: SelectedLineRange | null) => {
    const selection = toReviewLineSelection(range);
    // A range crossing old/new sides cannot be represented by the comment API.
    setSelectedLines(selection ? range : null);
    if (selection) onSelection?.(selection);
  }, [onSelection]);

  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    theme: THEMES,
    themeType: theme,
    diffStyle: layout,
    overflow: "wrap",
    disableFileHeader: true,
    // Preserve access to the complete files; the virtualizer bounds rendered rows.
    expandUnchanged: true,
    enableLineSelection: Boolean(onSelection),
    onLineSelected: onSelection ? selectLines : undefined,
    // The built-in gutter selection already commits its range; don't replace a
    // Shift-click or drag range with the subsequent single-line click event.
    onLineNumberClick: onSelection ? () => {} : undefined,
    onLineClick: onSelection ? ({ lineNumber, annotationSide }) => {
      if (!document.getSelection()?.isCollapsed) return;
      selectLines({ start: lineNumber, end: lineNumber, side: annotationSide });
    } : undefined,
    onPostRender: onSelection ? (node, _instance, phase) => {
      if (phase === "unmount") {
        selectionCleanup.current.get(node)?.();
        selectionCleanup.current.delete(node);
      } else if (phase === "mount") {
        const root = node.shadowRoot;
        if (!root) return;
        const readSelection = () => {
          const selection = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ?? document.getSelection();
          if (!selection || selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
          const start = selectionPoint(selection.anchorNode);
          const end = selectionPoint(selection.focusNode);
          if (start && end) selectLines({ start: start.line, side: start.side, end: end.line, endSide: end.side });
        };
        document.addEventListener("selectionchange", readSelection);
        selectionCleanup.current.set(node, () => document.removeEventListener("selectionchange", readSelection));
      }
    } : undefined,
  }), [theme, layout, onSelection, selectLines]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
    const scroll = hostRef.current?.querySelector<HTMLElement>(".pierre-diff-scroll");
    if (!scroll) return;
    if (onSelection && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const side = selectedLines?.side || (modifiedExists ? "additions" : "deletions");
      const current = selectedLines?.end || 1;
      const end = event.key === "Home" ? 1 : event.key === "End" ? lineCounts[side]
        : Math.max(1, Math.min(lineCounts[side], current + (event.key === "ArrowUp" ? -1 : 1)));
      selectLines({ side, start: event.shiftKey ? selectedLines?.start || current : end, end });
      const view = viewRef.current;
      const position = view?.instance.getLinePosition(end, side);
      if (view && position) {
        const top = view.virtualizer.getOffsetInScrollContainer(view.container) + position.top;
        view.virtualizer.scrollTo({ top: getDiffLineRevealScrollTop(
          view.virtualizer.getScrollTop(), scroll.clientHeight, top, position.height,
        ) });
      }
      return;
    }
    const distance = event.key === "PageDown" ? scroll.clientHeight : event.key === "PageUp" ? -scroll.clientHeight
      : event.key === "ArrowDown" ? LINE_HEIGHT : event.key === "ArrowUp" ? -LINE_HEIGHT : 0;
    if (distance || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      scroll.scrollTo({ top: event.key === "Home" ? 0 : event.key === "End" ? scroll.scrollHeight : scroll.scrollTop + distance });
    }
  };
  const style = useMemo(() => ({ "--diffs-font-family": fontFamily,
    "--diffs-font-size": `${FONT_SIZE}px`, "--diffs-line-height": `${LINE_HEIGHT}px`, colorScheme: theme }) as CSSProperties, [fontFamily, theme]);

  return <div ref={hostRef} className="pierre-diff" role="region" aria-label={path} tabIndex={0} style={style} onKeyDown={handleKeyDown}>
    <Virtualizer className="pierre-diff-scroll">
      <DiffCanvas files={files} options={options} selectedLines={selectedLines} view={viewRef} />
    </Virtualizer>
  </div>;
}
