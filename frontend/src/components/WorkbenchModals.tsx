import React, { lazy, Suspense } from "react";
import { CommandPalette, CommandPaletteMode } from "./CommandPalette";
import { WorkspaceSearchPanel } from "./WorkspaceSearchPanel";
import { ActionConfirmDialog, type ActionConfirmIntent } from "./ActionConfirmDialog";
import { useI18n } from "../i18n";
import type { FileNode, OpenFile, TeamRole } from "../types";
import type {
  WorkspaceSearchOptions,
  WorkspaceSearchResponse,
  WorkspaceSearchResult,
} from "../hooks/useFileSystem";

const SettingsModal = lazy(() =>
  import("./SettingsModal").then((module) => ({ default: module.SettingsModal }))
);
const DiffViewerModal = lazy(() =>
  import("./DiffViewerModal").then((module) => ({ default: module.DiffViewerModal }))
);
const DesktopMobilePairing = lazy(() =>
  import("../mobile/DesktopMobilePairing").then((module) => ({
    default: module.DesktopMobilePairing,
  }))
);

export interface WorkbenchModalsProps {
  token: string;
  username: string;
  isAdmin: boolean;
  teamRole: TeamRole | null;
  readOnlyWorkspace: boolean;
  workspaceDir: string;
  showToast: (msg: string) => void;

  // Settings Modal
  settingsVisible: boolean;
  onCloseSettings: () => void;
  editorFont: string;
  editorFontOptions: { label: string; family: string }[];
  onEditorFontChange: (font: string) => void;
  zoomLevel?: number;
  onZoomChange?: (level: number) => void;
  onResetZoom?: () => void;

  // Mobile Pairing
  mobilePairingVisible: boolean;
  desktopApp: boolean;
  onCloseMobilePairing: () => void;
  onSessionExpired: () => void;

  // Diff Viewer Modal
  diffViewerFile: OpenFile | null;
  conflictSourceMessage: string | null;
  theme: "light" | "dark";
  onCloseDiffViewer: () => void;
  onApplyMerge: (mergedContent: string) => void;
  onKeepLocalVersion: () => void;
  onReloadRemoteVersion: () => void;
  onForceSave?: () => void;

  // Action Confirm Dialog
  confirmIntent: ActionConfirmIntent | null;
  confirmBusy: boolean;
  confirmError: string | null;
  onCloseConfirm: () => void;
  onConfirmAction: () => void;

  // Command Palette
  commandPaletteVisible: boolean;
  commandPaletteMode: CommandPaletteMode;
  fileTree: FileNode[];
  onCloseCommandPalette: () => void;
  onOpenFile: (path: string) => void;
  onRunPaletteCommand: (command: any) => void;
  canFormatDocument: boolean;

  // Workspace Search Panel
  workspaceSearchVisible: boolean;
  workspaceSearchScope: string;
  onCloseWorkspaceSearch: () => void;
  onClearWorkspaceSearchScope: () => void;
  onSearchWorkspace: (options: WorkspaceSearchOptions) => Promise<WorkspaceSearchResponse>;
  onCancelWorkspaceSearch: () => void;
  onOpenSearchResult: (result: WorkspaceSearchResult) => void;
}

/**
 * 工作台全局模态框与浮层集合：
 * 统一承载设置弹窗、移动端配对、差异比对合并、通用确认对话框、命令面板及工作区全局搜索浮层
 */
export const WorkbenchModals: React.FC<WorkbenchModalsProps> = ({
  token,
  username,
  isAdmin,
  teamRole,
  readOnlyWorkspace,
  workspaceDir,
  showToast,

  settingsVisible,
  onCloseSettings,
  editorFont,
  editorFontOptions,
  onEditorFontChange,
  zoomLevel,
  onZoomChange,
  onResetZoom,

  mobilePairingVisible,
  desktopApp,
  onCloseMobilePairing,
  onSessionExpired,

  diffViewerFile,
  conflictSourceMessage,
  theme,
  onCloseDiffViewer,
  onApplyMerge,
  onKeepLocalVersion,
  onReloadRemoteVersion,
  onForceSave,

  confirmIntent,
  confirmBusy,
  confirmError,
  onCloseConfirm,
  onConfirmAction,

  commandPaletteVisible,
  commandPaletteMode,
  fileTree,
  onCloseCommandPalette,
  onOpenFile,
  onRunPaletteCommand,
  canFormatDocument,

  workspaceSearchVisible,
  workspaceSearchScope,
  onCloseWorkspaceSearch,
  onClearWorkspaceSearchScope,
  onSearchWorkspace,
  onCancelWorkspaceSearch,
  onOpenSearchResult,
}) => {
  const { t } = useI18n();

  return (
    <>
      <Suspense fallback={null}>
        {settingsVisible && (
          <SettingsModal
            token={token}
            currentUsername={username}
            isAdmin={isAdmin}
            teamRole={teamRole}
            readOnlyWorkspace={readOnlyWorkspace}
            workspaceId={workspaceDir}
            visible={settingsVisible}
            editorFont={editorFont}
            editorFontOptions={editorFontOptions}
            onEditorFontChange={onEditorFontChange}
            zoomLevel={zoomLevel}
            onZoomChange={onZoomChange}
            onResetZoom={onResetZoom}
            onClose={onCloseSettings}
            onShowToast={showToast}
          />
        )}
        {mobilePairingVisible && !desktopApp && (
          <DesktopMobilePairing
            token={token}
            onClose={onCloseMobilePairing}
            onSessionExpired={onSessionExpired}
          />
        )}
      </Suspense>

      {diffViewerFile && diffViewerFile.remoteContent !== undefined && (
        <Suspense fallback={<div className="panel-loading">{t("common.loading")}</div>}>
          <DiffViewerModal
            file={diffViewerFile}
            conflictSourceMessage={conflictSourceMessage}
            theme={theme}
            editorFont={editorFont}
            onClose={onCloseDiffViewer}
            onApplyMerge={onApplyMerge}
            onKeepLocalVersion={onKeepLocalVersion}
            onReloadRemoteVersion={onReloadRemoteVersion}
            onForceSave={onForceSave}
          />
        </Suspense>
      )}

      <ActionConfirmDialog
        intent={confirmIntent}
        busy={confirmBusy}
        error={confirmError}
        onClose={onCloseConfirm}
        onConfirm={onConfirmAction}
      />

      <CommandPalette
        visible={commandPaletteVisible}
        mode={commandPaletteMode}
        tree={fileTree}
        onClose={onCloseCommandPalette}
        onOpenFile={onOpenFile}
        onRunCommand={onRunPaletteCommand}
        canFormatDocument={canFormatDocument}
      />

      <WorkspaceSearchPanel
        visible={workspaceSearchVisible}
        tree={fileTree}
        scopePath={workspaceSearchScope}
        onClose={onCloseWorkspaceSearch}
        onClearScope={onClearWorkspaceSearchScope}
        onSearch={onSearchWorkspace}
        onCancelSearch={onCancelWorkspaceSearch}
        onOpenResult={onOpenSearchResult}
      />
    </>
  );
};
