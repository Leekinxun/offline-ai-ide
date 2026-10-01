import React, { lazy, Suspense } from "react";
import { TabBar } from "./TabBar";
import { EditorToolbar } from "./EditorToolbar";
import { WorkspaceWelcome } from "./WorkspaceWelcome";
import { ReferencePanel } from "./ReferencePanel";
import { useI18n } from "../i18n";
import {
  FileNode,
  OpenFile,
  DefinitionLocation,
  ReferenceLocation,
  SelectionInfo,
} from "../types";
import type { FilePreviewMode } from "../plugins/types";
import { getMatchingFilePreviewRenderer } from "../plugins/runtime";
import { isDebuggablePath } from "../utils/workspacePaths";
import type { DebugFrame } from "../hooks/useDebugger";
import type {
  EditorHighlightTarget,
  EditorNavigationTarget,
} from "../hooks/useWorkspaceFiles";
import { useFileSystem } from "../hooks/useFileSystem";
import { useTeam } from "../hooks/useTeam";
import type * as monaco from "monaco-editor";
import "./WorkbenchEditorArea.css";

const Editor = lazy(() =>
  import("./Editor").then((module) => ({ default: module.Editor }))
);

export interface WorkbenchEditorAreaProps {
  workspaceView: "chat" | "files";

  // TabBar
  openFiles: OpenFile[];
  activeFilePath: string | null;
  workspaceDir: string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onCloseOtherTabs: (path: string) => void;
  onCloseTabsToTheRight: (path: string) => void;
  onCloseAllTabs: () => void;
  onShowToast: (msg: string) => void;

  // Active File & Toolbar
  activeFile: OpenFile | null;
  workspaceLabel: string;
  activePreviewRenderer: ReturnType<typeof getMatchingFilePreviewRenderer>;
  activePreviewMode: FilePreviewMode;
  onSelectPreviewMode: (mode: FilePreviewMode) => void;
  editorAssistantVisible: boolean;
  onToggleEditorAssistant: () => void;
  terminalVisible: boolean;
  onToggleTerminal: (forceOpen?: boolean) => void;
  runDetailsVisible: boolean;
  onOpenChanges: () => void;
  onRunCurrent: () => void;
  readOnlyWorkspace: boolean;

  // Compare Mode
  compareFilePath: string | null;
  onSelectCompareFile: (path: string | null) => void;
  compareFile: OpenFile | null;
  compareScrollLinked: boolean;
  onToggleCompareScrollLinked: () => void;
  onCloseCompare: () => void;

  // Remote Conflict & Collaboration Banners
  activeConflictFile: OpenFile | null;
  activeConflictSourceMessage: string | null;
  onViewDiff: (path: string) => void;
  onKeepLocalVersion: () => void;
  onReloadRemoteVersion: () => void;
  onForceSaveAfterVersionConflict: () => Promise<void>;
  activeClaim?: { username: string; path: string } | null;
  username: string;
  activeCollaborators: { username: string }[];

  // Editor Props
  team: ReturnType<typeof useTeam>;
  theme: "light" | "dark";
  editorFont: string;
  treeRefreshNonce: number;
  editorViewStatesRef: React.MutableRefObject<Record<string, monaco.editor.ICodeEditorViewState | null>>;
  onEditorViewStateChange: (path: string, state: monaco.editor.ICodeEditorViewState | null) => void;
  onEditorChange: (content: string) => void;
  onSaveFile: () => void;
  onFormatDocument: (path: string, content: string) => Promise<string>;
  fs: ReturnType<typeof useFileSystem>;
  breakpointsByPath: Record<string, number[]>;
  debugActiveFrame: DebugFrame | null;
  onToggleBreakpoint: (path: string, line: number) => void;
  onSelectionChange: (info: SelectionInfo | null) => void;
  onNavigateToLocation: (
    path: string,
    selection: { startLine: number; startColumn: number; endLine: number; endColumn: number }
  ) => void;
  onFindDefinition: (symbol: string, currentPath: string) => Promise<DefinitionLocation | null>;
  onFindReferences?: (symbol: string, currentPath: string) => Promise<ReferenceLocation[]>;
  onReferencesFound?: (symbol: string, refs: ReferenceLocation[]) => void;
  editorRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
  compareEditorRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
  onCompareEditorReady: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
  editorNavigationTarget: EditorNavigationTarget | null;
  editorHighlightTarget: EditorHighlightTarget | null;
  onNavigationComplete: (requestId: number) => void;
  onHighlightComplete: (requestId: number) => void;

  // Preview Pane
  previewPaneRef: React.RefObject<HTMLDivElement | null>;
  activePreviewContent: React.ReactNode;

  // Welcome Fallback & References Panel
  fileTree: FileNode[];
  onQuickOpen: () => void;
  onOpenFolder: () => void;
  folderPickerBusy: boolean;
  onFocusChat: () => void;
  onOpenFile: (path: string) => void;
  referenceResult: { symbol: string; references: ReferenceLocation[] } | null;
  onCloseReference: () => void;
}

/**
 * 工作台中心编辑区组件：
 * 承载标签栏、工具条、冲突横幅、协作提示、单/双栏代码编辑器、富文本预览及无文件时的欢迎页
 */
export const WorkbenchEditorArea: React.FC<WorkbenchEditorAreaProps> = ({
  workspaceView,

  openFiles,
  activeFilePath,
  workspaceDir,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToTheRight,
  onCloseAllTabs,
  onShowToast,

  activeFile,
  workspaceLabel,
  activePreviewRenderer,
  activePreviewMode,
  onSelectPreviewMode,
  editorAssistantVisible,
  onToggleEditorAssistant,
  terminalVisible,
  onToggleTerminal,
  runDetailsVisible,
  onOpenChanges,
  onRunCurrent,
  readOnlyWorkspace,

  compareFilePath,
  onSelectCompareFile,
  compareFile,
  compareScrollLinked,
  onToggleCompareScrollLinked,
  onCloseCompare,

  activeConflictFile,
  activeConflictSourceMessage,
  onViewDiff,
  onKeepLocalVersion,
  onReloadRemoteVersion,
  onForceSaveAfterVersionConflict,
  activeClaim,
  username,
  activeCollaborators,

  team,
  theme,
  editorFont,
  treeRefreshNonce,
  editorViewStatesRef,
  onEditorViewStateChange,
  onEditorChange,
  onSaveFile,
  onFormatDocument,
  fs,
  breakpointsByPath,
  debugActiveFrame,
  onToggleBreakpoint,
  onSelectionChange,
  onNavigateToLocation,
  onFindDefinition,
  onFindReferences,
  onReferencesFound,
  editorRef,
  compareEditorRef,
  onCompareEditorReady,
  editorNavigationTarget,
  editorHighlightTarget,
  onNavigationComplete,
  onHighlightComplete,

  previewPaneRef,
  activePreviewContent,

  fileTree,
  onQuickOpen,
  onOpenFolder,
  folderPickerBusy,
  onFocusChat,
  onOpenFile,
  referenceResult,
  onCloseReference,
}) => {
  const { t } = useI18n();

  return (
    <div className={`editor-area${workspaceView === "chat" ? " workbench-surface-hidden" : ""}`}>
      <TabBar
        openFiles={openFiles}
        activeFilePath={activeFilePath}
        workspaceDir={workspaceDir}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseTabsToTheRight={onCloseTabsToTheRight}
        onCloseAllTabs={onCloseAllTabs}
        onShowToast={onShowToast}
      />
      {activeFile && (
        <EditorToolbar
          activeFile={activeFile}
          workspaceLabel={workspaceLabel}
          hasPreview={Boolean(activePreviewRenderer)}
          activePreviewMode={activePreviewMode}
          onSelectPreviewMode={onSelectPreviewMode}
          editorAssistantVisible={editorAssistantVisible}
          onToggleEditorAssistant={onToggleEditorAssistant}
          terminalVisible={terminalVisible}
          onToggleTerminal={onToggleTerminal}
          runDetailsVisible={runDetailsVisible}
          onOpenChanges={onOpenChanges}
          canRunCurrent={isDebuggablePath(activeFile.path)}
          onRunCurrent={() => void onRunCurrent()}
          readOnlyWorkspace={readOnlyWorkspace}
          openFiles={openFiles}
          compareFilePath={compareFilePath}
          onSelectCompareFile={onSelectCompareFile}
          compareFileActive={Boolean(compareFile)}
          compareScrollLinked={compareScrollLinked}
          onToggleCompareScrollLinked={onToggleCompareScrollLinked}
          onCloseCompare={onCloseCompare}
        />
      )}
      <div className="editor-main">
        {activeConflictFile && (
          <div className="editor-conflict-banner">
            <div className="editor-conflict-copy">
              <strong>{t("app.remoteConflictTitle")}</strong>
              <span>
                {activeConflictFile.remoteConflictReason === "save"
                  ? t("app.saveVersionConflictMessage")
                  : t("app.remoteConflictMessage")}
              </span>
              {activeConflictSourceMessage && (
                <span className="editor-conflict-source">
                  {activeConflictSourceMessage}
                </span>
              )}
            </div>
            <div className="editor-conflict-actions">
              <button
                className="editor-conflict-btn"
                onClick={() => onViewDiff(activeConflictFile.path)}
              >
                {t("app.viewDiff")}
              </button>
              <button
                className="editor-conflict-btn"
                onClick={onKeepLocalVersion}
              >
                {t("app.keepLocalVersion")}
              </button>
              <button
                className="editor-conflict-btn primary"
                onClick={onReloadRemoteVersion}
              >
                {t("app.loadRemoteVersion")}
              </button>
              {activeConflictFile.remoteConflictReason === "save" && (
                <button
                  className="editor-conflict-btn danger"
                  onClick={() => void onForceSaveAfterVersionConflict()}
                >
                  {t("app.overwriteRemoteVersion")}
                </button>
              )}
            </div>
          </div>
        )}
        {!activeConflictFile &&
          ((activeClaim && activeClaim.username !== username) ||
            activeCollaborators.length > 0) &&
          activeFilePath && (
            <div className="editor-collaboration-banner">
              <div className="editor-conflict-copy">
                <strong>{t("team.collaborationNoticeTitle")}</strong>
                <span>
                  {activeClaim && activeClaim.username !== username
                    ? t("team.collaborationClaimNotice", {
                        username: activeClaim.username,
                      })
                    : activeCollaborators.length > 0
                      ? t("team.collaborationPresenceNotice", {
                          usernames: activeCollaborators
                            .map((entry) => entry.username)
                            .join(", "),
                        })
                      : t("team.unclaimed")}
                </span>
              </div>
            </div>
          )}
        <Suspense fallback={<div className="panel-loading">{t("common.loading")}</div>}>
          {activeFile ? (
            compareFile ? (
              <div className="editor-compare-workbench" aria-label={t("editor.compareView")}>
                <section className="editor-compare-pane" aria-label={t("editor.comparePrimary")}>
                  <div className="editor-compare-pane-header">
                    <span>{t("editor.comparePrimary")}</span>
                    <strong title={activeFile.path}>{activeFile.name}</strong>
                  </div>
                  <Editor
                    key={`editor:${activeFile.path}`}
                    content={activeFile.content}
                    language={activeFile.language}
                    path={activeFile.path}
                    collaboration={team.collaboration}
                    theme={theme}
                    fontFamily={editorFont}
                    readOnly={readOnlyWorkspace}
                    openFiles={openFiles}
                    refreshNonce={treeRefreshNonce}
                    viewState={editorViewStatesRef.current[activeFile.path] || null}
                    onViewStateChange={onEditorViewStateChange}
                    onChange={onEditorChange}
                    onSave={onSaveFile}
                    onFormat={onFormatDocument}
                    onValidateDocument={fs.checkPythonDocument}
                    breakpoints={isDebuggablePath(activeFile.path) ? breakpointsByPath[activeFile.path] || [] : []}
                    debugExecutionLine={debugActiveFrame?.path === activeFile.path ? debugActiveFrame.line : undefined}
                    onToggleBreakpoint={isDebuggablePath(activeFile.path) && !readOnlyWorkspace ? (line) => onToggleBreakpoint(activeFile.path, line) : undefined}
                    onSelectionChange={onSelectionChange}
                    onNavigateToLocation={onNavigateToLocation}
                    onFindDefinition={onFindDefinition}
                    editorRef={editorRef}
                    onEditorReady={onCompareEditorReady}
                    navigationTarget={
                      editorNavigationTarget?.path === activeFile.path
                        ? editorNavigationTarget
                        : null
                    }
                    highlightTarget={
                      editorHighlightTarget?.path === activeFile.path
                        ? editorHighlightTarget
                        : null
                    }
                    onNavigationComplete={onNavigationComplete}
                    onHighlightComplete={onHighlightComplete}
                  />
                </section>
                <div className="editor-compare-divider" aria-hidden="true" />
                <section className="editor-compare-pane" aria-label={t("editor.compareReference")}>
                  <div className="editor-compare-pane-header">
                    <span>{t("editor.compareReference")}</span>
                    <strong title={compareFile.path}>{compareFile.name}</strong>
                  </div>
                  <Editor
                    key={`compare:${compareFile.path}`}
                    content={compareFile.content}
                    language={compareFile.language}
                    path={compareFile.path}
                    collaboration={team.collaboration}
                    theme={theme}
                    fontFamily={editorFont}
                    readOnly
                    openFiles={openFiles}
                    refreshNonce={treeRefreshNonce}
                    viewState={editorViewStatesRef.current[compareFile.path] || null}
                    onViewStateChange={onEditorViewStateChange}
                    onChange={() => undefined}
                    onSave={() => undefined}
                    onFormat={onFormatDocument}
                    onValidateDocument={fs.checkPythonDocument}
                    debugExecutionLine={debugActiveFrame?.path === compareFile.path ? debugActiveFrame.line : undefined}
                    onSelectionChange={() => undefined}
                    onNavigateToLocation={onNavigateToLocation}
                    onFindDefinition={onFindDefinition}
                    editorRef={compareEditorRef}
                    onEditorReady={onCompareEditorReady}
                    navigationTarget={
                      editorNavigationTarget?.path === compareFile.path
                        ? editorNavigationTarget
                        : null
                    }
                    highlightTarget={
                      editorHighlightTarget?.path === compareFile.path
                        ? editorHighlightTarget
                        : null
                    }
                    onNavigationComplete={onNavigationComplete}
                    onHighlightComplete={onHighlightComplete}
                  />
                </section>
              </div>
            ) : activePreviewRenderer ? (
              <div className="editor-workbench">
                <div
                  className={`editor-workbench-body mode-${activePreviewMode}`}
                >
                  {activePreviewMode !== "preview" && (
                    <div className="editor-workbench-pane">
                      <Editor
                        key={`editor:${activeFile.path}`}
                        content={activeFile.content}
                        language={activeFile.language}
                        path={activeFile.path}
                        collaboration={team.collaboration}
                        theme={theme}
                        fontFamily={editorFont}
                        readOnly={readOnlyWorkspace}
                        openFiles={openFiles}
                        refreshNonce={treeRefreshNonce}
                        viewState={
                          editorViewStatesRef.current[activeFile.path] || null
                        }
                        onViewStateChange={onEditorViewStateChange}
                        onChange={onEditorChange}
                        onSave={onSaveFile}
                        onFormat={onFormatDocument}
                        onValidateDocument={fs.checkPythonDocument}
                        breakpoints={isDebuggablePath(activeFile.path) ? breakpointsByPath[activeFile.path] || [] : []}
                        debugExecutionLine={debugActiveFrame?.path === activeFile.path ? debugActiveFrame.line : undefined}
                        onToggleBreakpoint={isDebuggablePath(activeFile.path) && !readOnlyWorkspace ? (line) => onToggleBreakpoint(activeFile.path, line) : undefined}
                        onSelectionChange={onSelectionChange}
                        onNavigateToLocation={onNavigateToLocation}
                        onFindDefinition={onFindDefinition}
                        editorRef={editorRef}
                        navigationTarget={
                          editorNavigationTarget?.path === activeFile.path
                            ? editorNavigationTarget
                            : null
                        }
                        highlightTarget={
                          editorHighlightTarget?.path === activeFile.path
                            ? editorHighlightTarget
                            : null
                        }
                        onNavigationComplete={onNavigationComplete}
                        onHighlightComplete={onHighlightComplete}
                      />
                    </div>
                  )}
                  {activePreviewMode === "split" && (
                    <div className="editor-workbench-divider" />
                  )}
                  {activePreviewMode !== "edit" && (
                    <div
                      className="editor-workbench-pane editor-preview-pane"
                      ref={previewPaneRef as any}
                    >
                      {activePreviewContent}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <Editor
                key={`editor:${activeFile.path}`}
                content={activeFile.content}
                language={activeFile.language}
                path={activeFile.path}
                collaboration={team.collaboration}
                theme={theme}
                fontFamily={editorFont}
                readOnly={readOnlyWorkspace}
                openFiles={openFiles}
                refreshNonce={treeRefreshNonce}
                viewState={editorViewStatesRef.current[activeFile.path] || null}
                onViewStateChange={onEditorViewStateChange}
                onChange={onEditorChange}
                onSave={onSaveFile}
                onFormat={onFormatDocument}
                onValidateDocument={fs.checkPythonDocument}
                breakpoints={isDebuggablePath(activeFile.path) ? breakpointsByPath[activeFile.path] || [] : []}
                debugExecutionLine={debugActiveFrame?.path === activeFile.path ? debugActiveFrame.line : undefined}
                onToggleBreakpoint={isDebuggablePath(activeFile.path) && !readOnlyWorkspace ? (line) => onToggleBreakpoint(activeFile.path, line) : undefined}
                onSelectionChange={onSelectionChange}
                onNavigateToLocation={onNavigateToLocation}
                onFindDefinition={onFindDefinition}
                onFindReferences={onFindReferences}
                onReferencesFound={onReferencesFound}
                editorRef={editorRef}
                navigationTarget={
                  editorNavigationTarget?.path === activeFile.path
                    ? editorNavigationTarget
                    : null
                }
                highlightTarget={
                  editorHighlightTarget?.path === activeFile.path
                    ? editorHighlightTarget
                    : null
                }
                onNavigationComplete={onNavigationComplete}
                onHighlightComplete={onHighlightComplete}
              />
            )
          ) : (
            <WorkspaceWelcome
              workspaceDir={workspaceDir}
              tree={fileTree}
              openFiles={openFiles}
              onQuickOpen={onQuickOpen}
              onOpenFolder={onOpenFolder}
              folderPickerBusy={folderPickerBusy}
              onFocusChat={onFocusChat}
              onOpenTerminal={() => onToggleTerminal(true)}
              onOpenFile={onOpenFile}
            />
          )}
        </Suspense>
        {referenceResult && (
          <ReferencePanel
            symbol={referenceResult.symbol}
            references={referenceResult.references}
            onNavigate={(path, selection) => void onNavigateToLocation(path, selection)}
            onClose={onCloseReference}
          />
        )}
      </div>
    </div>
  );
};
