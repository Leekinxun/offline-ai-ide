import React, { lazy, Suspense } from "react";
import { Sidebar } from "./Sidebar";
import { TaskSidebar } from "./TaskSidebar";
import { GitPanel } from "./GitPanel";
import { AgentBoard } from "./AgentBoard";
import { CheckpointPanel } from "./CheckpointPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { RunCenterPanel } from "./RunCenterPanel";
import { DebugPanel } from "./DebugPanel";
import type { TeamRole } from "../types";
import type { FileNode } from "../types";
import type { DebugFrame } from "../hooks/useDebugger";
import type { EditorProblem } from "../hooks/useEditorProblems";
import type {
  CopyEntryResult,
  MoveEntryResult,
} from "../hooks/useFileSystem";
import { useFileSystem } from "../hooks/useFileSystem";
import { useTeam } from "../hooks/useTeam";
import { useChat } from "../hooks/useChat";
import { useI18n } from "../i18n";

const TeamPanel = lazy(() =>
  import("./TeamPanel").then((module) => ({ default: module.TeamPanel }))
);

export interface WorkbenchLeftDockProps {
  // Panel visibility
  gitVisible: boolean;
  agentsVisible: boolean;
  teamVisible: boolean;
  checkpointsVisible: boolean;
  problemsVisible: boolean;
  runCenterVisible: boolean;
  debugVisible: boolean;
  workspaceView: "chat" | "files";

  // Context & credentials
  token: string;
  workspaceDir: string;
  workspaceLabel: string;
  theme: "light" | "dark";
  compactWorkspace: boolean;
  readOnlyWorkspace: boolean;
  isolatedWindow: boolean;
  desktopApp: boolean;
  username: string;

  // Active file & location navigation
  activeFilePath: string | null;
  openFile: (path: string) => void;
  onNavigateToLocation: (
    path: string,
    selection: { startLine: number; startColumn: number; endLine: number; endColumn: number }
  ) => void;
  onShowToast: (msg: string) => void;

  // Git & Delivery
  gitDiffRequest: { path: string; id: number } | null;
  onGitReview: (files?: string[]) => void;
  onOpenFollowUpRun: (runId: string) => Promise<void>;
  onCloseGit: () => void;

  // Agents
  onCloseAgents: () => void;

  // Team
  team: ReturnType<typeof useTeam>;
  onCloseTeam: () => void;

  // Checkpoints
  onCloseCheckpoints: () => void;
  onWorkspaceRestored: () => Promise<void>;
  onChangeWorkspace: (path: string) => Promise<boolean>;

  // Problems
  editorProblems: EditorProblem[];
  onProblemCountsChange: (counts: { errors: number; warnings: number }) => void;
  onCloseProblems: () => void;

  // Run Center
  onRunningChange: (label: string | null) => void;
  onCloseRunCenter: () => void;

  // Debugger
  cursorPos: { line: number; column: number };
  breakpointsByPath: Record<string, number[]>;
  onToggleBreakpoint: (path: string, line: number) => void;
  debugStartRequest: { id: number; path: string } | null;
  onActiveFrameChange: (frame: DebugFrame | null) => void;
  onCloseDebug: () => void;

  // Chat / Tasks
  chat: ReturnType<typeof useChat>;
  onNewTask: () => void;
  onLoadConversation: (id: string) => Promise<void>;

  // File tree
  fileTree: FileNode[];
  onCreateEntry: (path: string, isDirectory: boolean) => Promise<void>;
  onCopyEntry: (sourcePath: string, targetDirectory: string) => Promise<CopyEntryResult>;
  onMoveEntry: (sourcePath: string, targetDirectory: string) => Promise<MoveEntryResult>;
  onDeleteEntry: (path: string) => Promise<void>;
  onDeleteEntries: (paths: string[]) => Promise<void>;
  onRenameEntry: (oldPath: string, newPath: string) => Promise<void>;
  onDownloadEntry: (path: string, type: FileNode["type"]) => Promise<void>;
  onUploadEntries: (
    files: { path: string; file: File }[],
    options?: { overwrite?: boolean; targetPath?: string }
  ) => Promise<{ uploaded: number; overwritten: number }>;
  onRefreshTree: () => Promise<void>;
  pickingWorkspace: boolean;
  onPickDesktopWorkspace: () => Promise<void>;
  folderOpenRequestId: number;
  onSearchInPath: (path: string) => void;
  fs: ReturnType<typeof useFileSystem>;
}

/**
 * 工作台左侧多功能面板宿主容器：
 * 统一承载 Git、智能体看板、团队协同、检查点恢复、问题诊断、运行测试、交互调试、AI 任务视图及文件资源管理器
 */
export const WorkbenchLeftDock: React.FC<WorkbenchLeftDockProps> = ({
  gitVisible,
  agentsVisible,
  teamVisible,
  checkpointsVisible,
  problemsVisible,
  runCenterVisible,
  debugVisible,
  workspaceView,

  token,
  workspaceDir,
  workspaceLabel,
  theme,
  compactWorkspace,
  readOnlyWorkspace,
  isolatedWindow,
  desktopApp,
  username,

  activeFilePath,
  openFile,
  onNavigateToLocation,
  onShowToast,

  gitDiffRequest,
  onGitReview,
  onOpenFollowUpRun,
  onCloseGit,

  onCloseAgents,

  team,
  onCloseTeam,

  onCloseCheckpoints,
  onWorkspaceRestored,
  onChangeWorkspace,

  editorProblems,
  onProblemCountsChange,
  onCloseProblems,

  onRunningChange,
  onCloseRunCenter,

  cursorPos,
  breakpointsByPath,
  onToggleBreakpoint,
  debugStartRequest,
  onActiveFrameChange,
  onCloseDebug,

  chat,
  onNewTask,
  onLoadConversation,

  fileTree,
  onCreateEntry,
  onCopyEntry,
  onMoveEntry,
  onDeleteEntry,
  onDeleteEntries,
  onRenameEntry,
  onDownloadEntry,
  onUploadEntries,
  onRefreshTree,
  pickingWorkspace,
  onPickDesktopWorkspace,
  folderOpenRequestId,
  onSearchInPath,
  fs,
}) => {
  const { t } = useI18n();

  return (
    <aside className="workbench-left-dock" aria-label={t("sidebar.explorer")}>
      {gitVisible ? (
        <GitPanel
          key={`git:${workspaceDir}`}
          visible={true}
          token={token}
          workspaceDir={workspaceDir}
          theme={theme}
          drawerMode={compactWorkspace}
          readOnly={readOnlyWorkspace}
          conversationId={chat.currentConversationId}
          runId={chat.runState?.runId || null}
          requestedDiffPath={gitDiffRequest?.path}
          requestedDiffId={gitDiffRequest?.id}
          onOpenFile={openFile}
          onAskReview={onGitReview}
          onFollowUpCreated={(result) => {
            onShowToast(
              `${t("delivery.taskCreated", { id: result.taskId })} · ${result.followUpRunId.slice(0, 12)}`
            );
          }}
          onOpenFollowUpRun={onOpenFollowUpRun}
          onClose={onCloseGit}
        />
      ) : agentsVisible ? (
        <AgentBoard
          key={`agents:${workspaceDir}`}
          visible={true}
          token={token}
          drawerMode={compactWorkspace}
          onClose={onCloseAgents}
        />
      ) : teamVisible ? (
        <div
          className="team-sidebar workspace-drawer-host"
          style={{ height: "100%", width: "100%" }}
        >
          <Suspense fallback={<div className="panel-loading">{t("common.loading")}</div>}>
            <TeamPanel
              teams={team.teams}
              activeTeam={team.activeTeam}
              currentUsername={username}
              connected={team.connected}
              loading={team.loading}
              error={team.error}
              activeFilePath={activeFilePath}
              collaboration={team.collaboration}
              drawerMode={compactWorkspace}
              onClose={onCloseTeam}
              onRefresh={team.refresh}
              onCreateTeam={async (name) => {
                try {
                  await team.createTeam(name);
                  onShowToast(t("team.createdToast", { name }));
                } catch (error) {
                  onShowToast(
                    error instanceof Error ? error.message : t("sidebar.operationFailed")
                  );
                  throw error;
                }
              }}
              onJoinTeam={async (code) => {
                try {
                  const joined = await team.joinTeam(code);
                  onShowToast(t("team.joinedToast", { name: joined.name }));
                } catch (error) {
                  onShowToast(
                    error instanceof Error ? error.message : t("sidebar.operationFailed")
                  );
                  throw error;
                }
              }}
              onSwitchTeam={async (teamId) => {
                try {
                  const switched = await team.switchTeam(teamId);
                  onShowToast(t("team.switchedToast", { name: switched.name }));
                } catch (error) {
                  onShowToast(
                    error instanceof Error ? error.message : t("sidebar.operationFailed")
                  );
                  throw error;
                }
              }}
              onCreateInvite={async (teamId, role: TeamRole) => {
                try {
                  const invite = await team.createInvite(teamId, role);
                  onShowToast(t("team.inviteCreatedToast", { code: invite.code }));
                  return invite.code;
                } catch (error) {
                  onShowToast(
                    error instanceof Error ? error.message : t("sidebar.operationFailed")
                  );
                  throw error;
                }
              }}
              onUpdateMemberRole={async (memberUsername, role) => {
                if (!team.activeTeam) return;
                try {
                  await team.updateMemberRole(team.activeTeam.id, memberUsername, role);
                  onShowToast(
                    t("team.roleUpdatedToast", {
                      username: memberUsername,
                      role,
                    })
                  );
                } catch (error) {
                  onShowToast(
                    error instanceof Error ? error.message : t("sidebar.operationFailed")
                  );
                  throw error;
                }
              }}
              onTransferOwnership={async (memberUsername) => {
                if (!team.activeTeam) return;
                try {
                  await team.transferOwnership(team.activeTeam.id, memberUsername);
                  onShowToast(
                    t("team.ownerTransferredToast", { username: memberUsername })
                  );
                } catch (error) {
                  onShowToast(
                    error instanceof Error ? error.message : t("sidebar.operationFailed")
                  );
                  throw error;
                }
              }}
              onRemoveMember={async (memberUsername) => {
                if (!team.activeTeam) return;
                try {
                  await team.removeMember(team.activeTeam.id, memberUsername);
                  onShowToast(
                    t("team.memberRemovedToast", { username: memberUsername })
                  );
                } catch (error) {
                  onShowToast(
                    error instanceof Error ? error.message : t("sidebar.operationFailed")
                  );
                  throw error;
                }
              }}
              onLeaveTeam={async () => {
                if (!team.activeTeam) return;
                const leavingTeamName = team.activeTeam.name;
                try {
                  await team.leaveTeam(team.activeTeam.id);
                  onShowToast(t("team.leftTeamToast", { name: leavingTeamName }));
                } catch (error) {
                  onShowToast(
                    error instanceof Error ? error.message : t("sidebar.operationFailed")
                  );
                  throw error;
                }
              }}
              onToggleClaim={async (path, claimed) => {
                if (!team.activeTeam) return;
                await team.setClaim(team.activeTeam.id, path, claimed);
                onShowToast(
                  claimed ? t("team.claimedToast", { path }) : t("team.releasedToast", { path })
                );
              }}
              onAddComment={team.addCollaborationComment}
              onCreateReview={team.createCollaborationReview}
              onCreateMergePreview={team.createMergePreview}
              onDecideMerge={team.decideMerge}
            />
          </Suspense>
        </div>
      ) : checkpointsVisible ? (
        <CheckpointPanel
          key={`checkpoints:${workspaceDir}`}
          visible={true}
          token={token}
          workspaceDir={workspaceDir}
          conversationId={chat.currentConversationId}
          runId={chat.runState?.runId || null}
          readOnly={readOnlyWorkspace}
          onClose={onCloseCheckpoints}
          onRestored={onWorkspaceRestored}
          onOpenWorktree={async (path) => {
            await onChangeWorkspace(path);
          }}
          onNotify={onShowToast}
        />
      ) : problemsVisible ? (
        <ProblemsPanel
          key={`problems:${workspaceDir}`}
          visible={true}
          token={token}
          editorProblems={editorProblems}
          onCountsChange={onProblemCountsChange}
          onOpenLocation={(problem) =>
            void onNavigateToLocation(problem.path, {
              startLine: problem.line,
              startColumn: problem.column,
              endLine: problem.line,
              endColumn: problem.column + 1,
            })
          }
          onClose={onCloseProblems}
        />
      ) : runCenterVisible ? (
        <RunCenterPanel
          key={`run:${workspaceDir}`}
          visible={true}
          token={token}
          onRunningChange={onRunningChange}
          onOpenLocation={(failure) =>
            void onNavigateToLocation(failure.path, {
              startLine: failure.line,
              startColumn: failure.column,
              endLine: failure.line,
              endColumn: failure.column + 1,
            })
          }
          onClose={onCloseRunCenter}
        />
      ) : debugVisible ? (
        <DebugPanel
          key={`debug:${workspaceDir}`}
          visible={true}
          token={token}
          activeFilePath={activeFilePath}
          cursorLine={cursorPos.line}
          breakpointsByPath={breakpointsByPath}
          onToggleBreakpoint={onToggleBreakpoint}
          startRequest={debugStartRequest}
          onOpenLocation={(frame) =>
            void onNavigateToLocation(frame.path, {
              startLine: frame.line,
              startColumn: frame.column,
              endLine: frame.line,
              endColumn: frame.column + 1,
            })
          }
          onActiveFrameChange={onActiveFrameChange}
          onClose={onCloseDebug}
        />
      ) : workspaceView === "chat" ? (
        <TaskSidebar
          workspaceLabel={workspaceLabel}
          workspaceDir={workspaceDir}
          conversations={chat.conversations}
          currentConversationId={chat.currentConversationId}
          contextState={chat.contextState}
          loading={chat.historyLoading}
          loadingId={chat.historyLoadingId}
          isStreaming={chat.isStreaming}
          onNewTask={onNewTask}
          onLoadConversation={onLoadConversation}
          onDeleteConversation={chat.deleteConversation}
          onRefresh={chat.refreshConversations}
        />
      ) : (
        <Sidebar
          tree={fileTree}
          activeFilePath={activeFilePath}
          visible={true}
          onFileSelect={openFile}
          onCreateEntry={onCreateEntry}
          onCopyEntry={onCopyEntry}
          onMoveEntry={onMoveEntry}
          onDeleteEntry={onDeleteEntry}
          onDeleteEntries={onDeleteEntries}
          onRenameEntry={onRenameEntry}
          onDownloadEntry={onDownloadEntry}
          onUploadEntries={onUploadEntries}
          onRefreshTree={onRefreshTree}
          workspaceDir={workspaceDir}
          workspaceLocked={isolatedWindow}
          desktopApp={desktopApp}
          folderPickerBusy={pickingWorkspace}
          onPickDesktopWorkspace={onPickDesktopWorkspace}
          folderOpenRequestId={folderOpenRequestId}
          onChangeWorkspace={onChangeWorkspace}
          onSearchInPath={onSearchInPath}
          onSearchContent={fs.searchWorkspace}
          onCancelContentSearch={fs.cancelWorkspaceSearch}
          token={token}
          activeTeam={team.activeTeam}
        />
      )}
    </aside>
  );
};
