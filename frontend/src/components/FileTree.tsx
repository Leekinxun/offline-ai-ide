import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FILE_TREE_TAG_NAME, preparePresortedFileTreeInput } from "@pierre/trees";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import "./FileTree.css";
import { FileNode, TeamClaim, TeamPresence } from "../types";
import { useI18n } from "../i18n";
import { buildTreeInput, fromTreePath, getExpandedTreePaths, restoreTreeExpansion, syncTreeSelection } from "./fileTreeAdapter";

export const FILE_TREE_DRAG_TYPE = "application/x-crewforge-file-path";

interface FileTreeProps {
  nodes: FileNode[];
  activeFilePath: string | null;
  selectedPaths: Set<string>;
  multiSelectEnabled: boolean;
  canEditWorkspace?: boolean;
  onFileSelect: (path: string) => void;
  onToggleSelect: (path: string, selected: boolean) => void;
  onDownload: (path: string, type: FileNode["type"]) => void;
  onContextMenu: (position: { clientX: number; clientY: number }, node: FileNode) => void;
  onDropFiles: (targetPath: string, files: FileList) => void;
  onMoveEntry: (sourcePath: string, targetDirectory: string) => void;
  claims?: TeamClaim[];
  presence?: TeamPresence[];
  filterQuery?: string;
}

/** The beta renderer has text decorations, not interactive React row slots. */
const TREE_ROW_CSS = `
  [data-type="item"] { border-radius: 4px; margin: 0; font-size: 12px; }
  [data-item-section="decoration"] { padding-inline: 2px; }
  [data-item-section="decoration"] > span { display: flex; align-items: center; gap: 5px; }
  [data-item-section="decoration"] > span > span:first-child,
  [data-item-section="decoration"] > span > span:last-child {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 22px; border-radius: 4px; cursor: pointer;
  }
  [data-item-section="decoration"] > span > span:first-child { opacity: 0; }
  [data-item-section="decoration"] > span > span:last-child { font-size: 17px; opacity: 0; }
  [data-item-section="decoration"] > span > span:nth-child(2) {
    font-size: 10px; max-width: 80px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--trees-fg-muted);
  }
  :host([data-multi-select="true"]) [data-item-section="decoration"] > span > span:first-child,
  [data-type="item"]:hover [data-item-section="decoration"] > span > span:first-child,
  [data-item-selected="true"] [data-item-section="decoration"] > span > span:first-child,
  [data-type="item"]:focus-visible [data-item-section="decoration"] > span > span:first-child,
  [data-type="item"]:hover [data-item-section="decoration"] > span > span:last-child,
  [data-type="item"]:focus-visible [data-item-section="decoration"] > span > span:last-child { opacity: 1; }
  [data-item-section="decoration"] > span > span:first-child:hover,
  [data-item-section="decoration"] > span > span:last-child:hover { background: var(--trees-bg-muted); }
  :host([data-read-only="true"]) [data-item-section="decoration"] > span > span:first-child { cursor: default; opacity: .35; }
`;

function eventRow(event: Event): HTMLElement | undefined {
  // event.target is the custom element after Shadow DOM retargeting.
  return event.composedPath().find((entry): entry is HTMLElement =>
    entry instanceof HTMLElement && entry.dataset.itemPath !== undefined && entry.dataset.type === "item",
  );
}

function decorationAction(event: Event): "select" | "download" | undefined {
  for (const entry of event.composedPath()) {
    if (!(entry instanceof HTMLElement)) continue;
    if (entry.parentElement?.parentElement?.dataset.itemSection !== "decoration") continue;
    const index = Array.from(entry.parentElement.children).indexOf(entry);
    if (index === 0) return "select";
    if (index === 2) return "download";
  }
}

export const FileTree: React.FC<FileTreeProps> = (props) => {
  const { t } = useI18n();
  const latest = useRef(props);
  latest.current = props;
  const shellRef = useRef<HTMLDivElement>(null);
  const input = useMemo(() => buildTreeInput(props.nodes), [props.nodes]);
  const inputRef = useRef(input);
  inputRef.current = input;
  const preparedInput = useMemo(() => preparePresortedFileTreeInput(input.paths), [input]);
  const isFiltering = Boolean(props.filterQuery?.trim());
  const expansionRef = useRef({ filtering: isFiltering, directoryPaths: input.directoryPaths, saved: [] as string[] });
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const { model } = useFileTree({
    preparedInput,
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
    itemHeight: 29,
    overscan: 8,
    icons: { set: "standard", colored: true },
    search: false,
    // Persist through the existing filesystem callbacks before refreshing the
    // tree. Capture handlers prevent the library's optimistic in-memory move.
    dragAndDrop: {
      canDrag: () => latest.current.canEditWorkspace !== false,
      // Touch gestures can bypass native DragEvents. They must never perform
      // a model-only move that the filesystem has not acknowledged.
      canDrop: () => false,
    },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "right-click",
        onOpen: (item, context) => {
          const node = inputRef.current.nodesByPath.get(fromTreePath(item.path));
          if (node) latest.current.onContextMenu({ clientX: context.anchorRect.left, clientY: context.anchorRect.top }, node);
          // Sidebar owns the app menu, permission checks, and dialogs. Avoid
          // leaving an empty library menu/wash above that surface.
          context.close({ restoreFocus: false });
        },
      },
    },
    renderRowDecoration: ({ item }) => {
      const path = fromTreePath(item.path);
      const current = latest.current;
      const claim = current.claims?.find((entry) => entry.path === path);
      const viewers = current.presence?.filter((entry) => entry.activeFilePath === path).length || 0;
      return {
        text: "",
        parts: [
          { text: current.selectedPaths.has(path) ? "☑" : "☐", color: "var(--trees-accent)" },
          { text: claim ? `✋ ${claim.username}` : viewers ? `${viewers} 👀` : "" },
          { text: "↓" },
        ],
      };
    },
    unsafeCSS: TREE_ROW_CSS,
  });

  useLayoutEffect(() => {
    const previous = expansionRef.current;
    if (!previous.filtering) previous.saved = getExpandedTreePaths(model, previous.directoryPaths);
    const expandedPaths = isFiltering ? input.directoryPaths : previous.saved;
    model.resetPaths({ preparedInput, initialExpandedPaths: expandedPaths });
    restoreTreeExpansion(model, input.directoryPaths, expandedPaths);
    expansionRef.current = { filtering: isFiltering, directoryPaths: input.directoryPaths, saved: previous.saved };
  }, [input.directoryPaths, isFiltering, model, preparedInput]);

  useLayoutEffect(() => {
    syncTreeSelection(model, props.selectedPaths);
    const host = model.getFileTreeContainer();
    if (host) model.render({ fileTreeContainer: host });
  }, [model, preparedInput, props.selectedPaths, props.claims, props.presence]);

  // App-owned metadata/styles only: navigation and virtualization stay on the
  // public model. No interactive element is inserted into a treeitem button.
  useEffect(() => {
    const host = shellRef.current?.querySelector<HTMLElement>(FILE_TREE_TAG_NAME);
    const root = host?.shadowRoot;
    if (!root) return;
    const labelRows = () => {
      root.querySelector('[role="tree"]')?.setAttribute("aria-label", t("sidebar.explorer"));
      for (const row of root.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
        row.setAttribute("aria-keyshortcuts", "Alt+D Control+Space Meta+Space");
        const downloadLabel = t(row.dataset.itemType === "folder" ? "sidebar.downloadFolder" : "sidebar.downloadFile");
        row.setAttribute("aria-description", `${t("sidebar.selectForBatchDelete")} (Control/Command+Space); ${downloadLabel} (Alt+D)`);
        const parts = row.querySelectorAll<HTMLElement>('[data-item-section="decoration"] > span > span');
        if (parts[0]) parts[0].title = `${t("sidebar.selectForBatchDelete")} (Control/Command+Space)`;
        if (parts[2]) parts[2].title = `${downloadLabel} (Alt+D)`;
      }
    };
    labelRows();
    const observer = new MutationObserver(labelRows);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [model, t]);

  useEffect(() => {
    const host = shellRef.current?.querySelector<HTMLElement>(FILE_TREE_TAG_NAME);
    const root = host?.shadowRoot;
    if (!root) return;
    const style = document.createElement("style");
    style.dataset.crewforgeTreeState = "true";
    const activePath = props.activeFilePath;
    style.textContent = [
      activePath ? `[data-item-path="${CSS.escape(activePath)}"] { background: color-mix(in srgb, var(--trees-accent) 16%, transparent); box-shadow: inset 2px 0 var(--trees-accent); }
      [data-item-path="${CSS.escape(activePath)}"] [data-item-section="decoration"] > span > span:last-child { opacity: 1; }` : "",
      dropTargetPath ? `[data-item-path="${CSS.escape(`${dropTargetPath}/`)}"] { background: color-mix(in srgb, var(--trees-accent) 20%, transparent); box-shadow: inset 0 0 0 1px var(--trees-accent); }` : "",
    ].join("\n");
    root.append(style);
    return () => style.remove();
  }, [dropTargetPath, model, props.activeFilePath]);

  const nodeForEvent = (event: Event) => {
    const row = eventRow(event);
    return row?.dataset.itemPath ? input.nodesByPath.get(fromTreePath(row.dataset.itemPath)) : undefined;
  };
  const toggleSelection = (node: FileNode) => props.onToggleSelect(node.path, !props.selectedPaths.has(node.path));
  const activate = (node: FileNode, toggle: boolean) => {
    const item = model.getItem(node.path);
    item?.focus();
    if (toggle) toggleSelection(node);
    else if (node.type === "file") props.onFileSelect(node.path);
    else if (item && "toggle" in item && !isFiltering) item.toggle();
  };
  const stop = (event: React.SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); };

  return (
    <div className="crewforge-file-tree-shell" ref={shellRef}>
      <PierreFileTree
        model={model}
        data-multi-select={props.multiSelectEnabled ? "true" : "false"}
        data-read-only={props.canEditWorkspace === false ? "true" : "false"}
        onClickCapture={(event) => {
          const node = nodeForEvent(event.nativeEvent);
          if (!node) return;
          stop(event);
          const action = decorationAction(event.nativeEvent);
          if (action === "download") { void props.onDownload(node.path, node.type); return; }
          if (action === "select") { if (props.canEditWorkspace !== false) toggleSelection(node); return; }
          activate(node, props.multiSelectEnabled || event.ctrlKey || event.metaKey);
        }}
        onKeyDownCapture={(event) => {
          if (!eventRow(event.nativeEvent)) return;
          const item = model.getFocusedItem();
          const node = item && input.nodesByPath.get(fromTreePath(item.getPath()));
          if (!node) return;
          if (event.altKey && event.key.toLowerCase() === "d") { stop(event); void props.onDownload(node.path, node.type); }
          else if ((event.ctrlKey || event.metaKey) && event.key === " ") { stop(event); toggleSelection(node); }
          else if (event.key === "Enter" || event.key === " ") { stop(event); activate(node, props.multiSelectEnabled || event.ctrlKey || event.metaKey); }
          else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") stop(event);
          else if (event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            stop(event);
            if (event.key === "ArrowDown") model.focusNextItem(); else model.focusPreviousItem();
          } else if (event.key === "ArrowRight" && node.type === "file") stop(event);
          else if (event.key === "ArrowLeft" && isFiltering) { stop(event); model.focusParentItem(); }
        }}
        onContextMenu={(event) => { if (eventRow(event.nativeEvent)) event.stopPropagation(); }}
        onTouchStartCapture={(event) => {
          if (eventRow(event.nativeEvent)) event.stopPropagation();
        }}
        onDragStartCapture={(event) => {
          const node = nodeForEvent(event.nativeEvent);
          if (!node) return;
          event.stopPropagation();
          if (props.canEditWorkspace === false) { event.preventDefault(); return; }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(FILE_TREE_DRAG_TYPE, node.path);
          event.dataTransfer.setData("text/plain", node.path);
        }}
        onDragEndCapture={(event) => { event.stopPropagation(); setDropTargetPath(null); }}
        onDragOverCapture={(event) => {
          const node = nodeForEvent(event.nativeEvent);
          const internal = event.dataTransfer.types.includes(FILE_TREE_DRAG_TYPE);
          if (props.canEditWorkspace === false || node?.type !== "directory" || (!internal && !event.dataTransfer.types.includes("Files"))) return;
          stop(event);
          event.dataTransfer.dropEffect = internal ? "move" : "copy";
          setDropTargetPath(node.path);
        }}
        onDragLeaveCapture={(event) => {
          const row = eventRow(event.nativeEvent);
          if (!(event.relatedTarget instanceof Node) || !row?.contains(event.relatedTarget)) setDropTargetPath(null);
        }}
        onDropCapture={(event) => {
          const node = nodeForEvent(event.nativeEvent);
          if (props.canEditWorkspace === false || node?.type !== "directory") return;
          const sourcePath = event.dataTransfer.getData(FILE_TREE_DRAG_TYPE);
          if (!sourcePath && !event.dataTransfer.files.length) return;
          stop(event);
          setDropTargetPath(null);
          if (sourcePath) props.onMoveEntry(sourcePath, node.path);
          else props.onDropFiles(node.path, event.dataTransfer.files);
        }}
      />
    </div>
  );
};
