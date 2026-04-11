import React from "react";
import { OpenFile } from "../types";
import { X } from "lucide-react";

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
  if (openFiles.length === 0) return null;

  return (
    <div className="tabbar">
      {openFiles.map((file) => (
        <div
          key={file.path}
          className={`tab${file.path === activeFilePath ? " active" : ""}`}
          onClick={() => onSelectTab(file.path)}
        >
          {file.modified && <span className="tab-modified" />}
          <span className="tab-name">{file.name}</span>
          <button
            className="tab-close"
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
