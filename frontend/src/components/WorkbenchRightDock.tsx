import React from "react";
import { RunDetailsPanel, DetailTab } from "./RunDetailsPanel";
import { EditorAssistantPanel } from "./EditorAssistantPanel";
import { useI18n } from "../i18n";
import type { OpenFile } from "../types";
import { useChat } from "../hooks/useChat";

export interface WorkbenchRightDockProps {
  workspaceView: "chat" | "files";
  editorAssistantVisible: boolean;
  runDetailsVisible: boolean;
  setEditorAssistantVisible: (visible: boolean) => void;
  setRunDetailsVisible: (visible: boolean) => void;
  runDetailsTab: DetailTab;
  setRunDetailsTab: (tab: DetailTab) => void;

  token: string;
  workspaceDir: string;
  chat: ReturnType<typeof useChat>;
  problemCounts: { errors: number; warnings: number };
  openFile: (path: string) => void;
  onOpenGitDiff: (path: string) => void;

  activeFilePath: string | null;
  activeFile: OpenFile | null;
  chatDraftText: string;
  setChatDraftText: (text: string) => void;
  chatAttachmentDraft: any;
  attachmentWarning: string | null;
  pendingAttachmentVerificationIds: Set<string>;
  attachmentSubmissionError: string | null;
  attachmentSubmissionNotice: string | null;
  editedRetryNotice: string | null;
  readOnlyWorkspace: boolean;
  onSend: (message: string) => boolean;
  onSteer: (message: string) => boolean;
  onNewConversation: () => void;
}

/**
 * 工作台右侧多功能抽屉容器：
 * 承载代码助手侧栏 (EditorAssistantPanel) 与执行状态/代码审查详情面板 (RunDetailsPanel)
 */
export const WorkbenchRightDock: React.FC<WorkbenchRightDockProps> = ({
  workspaceView,
  editorAssistantVisible,
  runDetailsVisible,
  setEditorAssistantVisible,
  setRunDetailsVisible,
  runDetailsTab,
  setRunDetailsTab,

  token,
  workspaceDir,
  chat,
  problemCounts,
  openFile,
  onOpenGitDiff,

  activeFilePath,
  activeFile,
  chatDraftText,
  setChatDraftText,
  chatAttachmentDraft,
  attachmentWarning,
  pendingAttachmentVerificationIds,
  attachmentSubmissionError,
  attachmentSubmissionNotice,
  editedRetryNotice,
  readOnlyWorkspace,
  onSend,
  onSteer,
  onNewConversation,
}) => {
  const { t } = useI18n();

  return (
    <>
      {workspaceView === "files" && (editorAssistantVisible || runDetailsVisible) && (
        <aside
          className="workbench-right-dock"
          aria-label={runDetailsVisible ? t("workbench.runDetails") : t("workbench.editorAssistant")}
        >
          {runDetailsVisible ? (
            <RunDetailsPanel
              token={token}
              workspaceDir={workspaceDir}
              visible={runDetailsVisible}
              summary={chat.currentRunSummary}
              runState={chat.runState}
              errorCount={problemCounts.errors}
              warningCount={problemCounts.warnings}
              contextManifest={chat.contextManifest}
              activeTab={runDetailsTab}
              onTabChange={setRunDetailsTab}
              onOpenFile={openFile}
              onOpenDiff={onOpenGitDiff}
              onClose={() => {
                setRunDetailsVisible(false);
                if (workspaceView === "files" && window.innerWidth > 1180) {
                  setEditorAssistantVisible(true);
                }
              }}
            />
          ) : (
            <EditorAssistantPanel
              token={token}
              visible={true}
              activeFilePath={activeFilePath}
              activeFileDirty={Boolean(activeFile?.modified)}
              messages={chat.messages}
              connected={chat.connected}
              isStreaming={chat.isStreaming}
              agentMode={chat.agentMode}
              runtimeOptions={chat.runtimeOptions}
              selectedModelName={chat.selectedModelName}
              draftText={chatDraftText}
              onDraftTextChange={setChatDraftText}
              attachmentDraft={chatAttachmentDraft}
              attachmentWarning={attachmentWarning}
              attachmentDeliveryChecking={pendingAttachmentVerificationIds.size > 0}
              onRecheckAttachmentDelivery={() => void chat.recheckAttachmentSends()}
              attachmentSubmissionError={attachmentSubmissionError}
              attachmentSubmissionNotice={editedRetryNotice || attachmentSubmissionNotice}
              runState={chat.runState}
              currentRunSummary={chat.currentRunSummary}
              contextManifest={chat.contextManifest}
              contextReadOnly={readOnlyWorkspace}
              pendingApprovals={chat.pendingApprovals}
              onAgentModeChange={chat.setAgentMode}
              onModelNameChange={chat.setSelectedModelName}
              onSend={onSend}
              onSteer={onSteer}
              onStop={chat.stopCurrentRun}
              onResume={chat.resumeConversation}
              onNewConversation={onNewConversation}
              onToolApproval={chat.respondToToolApproval}
              onApproveConversationTools={chat.approveConversationTools}
              onPlanAmendmentDecision={chat.decidePlanAmendment}
              onClose={() => setEditorAssistantVisible(false)}
            />
          )}
        </aside>
      )}

      {workspaceView === "chat" && runDetailsVisible && (
        <RunDetailsPanel
          token={token}
          workspaceDir={workspaceDir}
          visible={runDetailsVisible}
          summary={chat.currentRunSummary}
          runState={chat.runState}
          errorCount={problemCounts.errors}
          warningCount={problemCounts.warnings}
          contextManifest={chat.contextManifest}
          activeTab={runDetailsTab}
          onTabChange={setRunDetailsTab}
          onOpenFile={openFile}
          onOpenDiff={onOpenGitDiff}
          onClose={() => setRunDetailsVisible(false)}
        />
      )}
    </>
  );
};
