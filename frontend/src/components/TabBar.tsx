import React, { useMemo, useRef } from "react";
import { OpenFile } from "../types";
import { X } from "lucide-react";
import { useI18n } from "../i18n";

interface TabBarProps {
  openFiles: OpenFile[];
  activeFilePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
}

export const TabBar: React.FC<TabBarProps> = ({
  openFiles,
  activeFilePath,
  onSelectTab,
  onCloseTab,
}) => {
  const { t } = useI18n();
  const tabRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pathLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const file of openFiles) {
      const peers = openFiles.filter((candidate) => candidate.name === file.name);
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
  }, [openFiles]);

  if (openFiles.length === 0) return null;

  return (
    <div className="tabbar" role="tablist" aria-label="Open files">
      {openFiles.map((file, index) => (
        <div
          key={file.path}
          ref={(element) => { tabRefs.current[index] = element; }}
          className={`tab${file.path === activeFilePath ? " active" : ""}${file.modified ? " modified" : ""}`}
          onClick={() => onSelectTab(file.path)}
          role="tab"
          aria-selected={file.path === activeFilePath}
          title={file.path}
          tabIndex={file.path === activeFilePath ? 0 : -1}
          aria-label={`${file.name}${file.modified ? `, ${t("tabs.unsaved")}` : ""}${file.remoteUpdated ? `, ${t("tabs.remoteUpdated")}` : ""}`}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelectTab(file.path);
              return;
            }
            let nextIndex: number | null = null;
            if (event.key === "ArrowRight") nextIndex = (index + 1) % openFiles.length;
            if (event.key === "ArrowLeft") nextIndex = (index - 1 + openFiles.length) % openFiles.length;
            if (event.key === "Home") nextIndex = 0;
            if (event.key === "End") nextIndex = openFiles.length - 1;
            if (nextIndex !== null) {
              event.preventDefault();
              const nextFile = openFiles[nextIndex];
              onSelectTab(nextFile.path);
              window.requestAnimationFrame(() => tabRefs.current[nextIndex!]?.focus());
              return;
            }
            if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              onCloseTab(file.path);
              const focusIndex = Math.min(index, openFiles.length - 2);
              if (focusIndex >= 0) {
                window.requestAnimationFrame(() => tabRefs.current[focusIndex]?.focus());
              }
            }
          }}
        >
          {file.modified && <span className="tab-modified" title={t("tabs.unsaved")} />}
          {file.remoteUpdated && <span className="tab-remote-updated" title={t("tabs.remoteUpdated")} />}
          <span className="tab-label">
            <span className="tab-name">{file.name}</span>
            {pathLabels.get(file.path) && <span className="tab-path">{pathLabels.get(file.path)}</span>}
          </span>
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
      ))}
    </div>
  );
};
