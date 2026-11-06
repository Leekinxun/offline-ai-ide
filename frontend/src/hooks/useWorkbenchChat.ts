import { useState, useRef, useCallback, useEffect, Dispatch, SetStateAction, RefObject, MutableRefObject } from "react";
import type * as monaco from "monaco-editor";
import {
  useChat,
  RejectedAttachmentSend,
  AttachmentSendReconciliation,
} from "./useChat";
import {
  useChatAttachmentDraft,
} from "../components/ChatAttachmentPicker";
import {
  OpenFile,
  FileUpdate,
  SelectionInfo,
  ChatAttachmentRef,
  ContextReference,
  getLanguage,
} from "../types";
import {
  normalizeWorkspaceRelativePath,
  isSameWorkspacePath,
  buildClearedRemoteState,
  applyRemoteFileRename,
  applyRemoteFileMetadata,
  applyRemoteFileSnapshot,
  beginFileRead,
  createFileReadScope,
  isCurrentFileRead,
  type FileSnapshot,
} from "../editor/fileUpdatePolicy";
import { remapMovedPath } from "../utils/workspacePaths";
import type { EditorHighlightTarget, EditorNavigationTarget } from "./useWorkspaceFiles";

export type WorkspaceView = "chat" | "files";

export interface WorkbenchChatOptions {
  token: string;
  workspaceDir: string;
  readOnlyWorkspace: boolean;
  activeFilePath: string | null;
  openFiles: OpenFile[];
  setOpenFiles: Dispatch<SetStateAction<OpenFile[]>>;
  setActiveFilePath: Dispatch<SetStateAction<string | null>>;
  setWorkspaceView: (view: WorkspaceView) => void;
  setEditorHighlightTarget: Dispatch<SetStateAction<EditorHighlightTarget | null>>;
  setEditorNavigationTarget: Dispatch<SetStateAction<EditorNavigationTarget | null>>;
  highlightRequestRef: MutableRefObject<number>;
  navigationRequestRef: MutableRefObject<number>;
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  selectionInfo: SelectionInfo | null;
  fs: {
    readFileWithMeta: (path: string) => Promise<{
      content: string;
      version?: string;
      updatedAt?: number;
      source?: "team_member" | "external" | "assistant_tool" | "unknown";
      actor?: string;
    }>;
  };
  loadTree: () => Promise<void> | void;
  beginPreserveOpenPath: (path: string) => () => void;
  focusChat: () => void;
  showToast: (msg: string) => void;
  t: (key: string, options?: any) => string;
  workspaceView: WorkspaceView;
  setRunDetailsVisible: (visible: boolean) => void;
  setEditorAssistantVisible: (visible: boolean) => void;
}

export function useWorkbenchChat({
  token,
  workspaceDir,
  readOnlyWorkspace,
  activeFilePath,
  openFiles,
  setOpenFiles,
  setActiveFilePath,
  setWorkspaceView,
  setEditorHighlightTarget,
  setEditorNavigationTarget,
  highlightRequestRef,
  navigationRequestRef,
  editorRef,
  selectionInfo,
  fs,
  loadTree,
  beginPreserveOpenPath,
  focusChat,
  showToast,
  t,
  workspaceView,
  setRunDetailsVisible,
  setEditorAssistantVisible,
}: WorkbenchChatOptions) {
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const fileReadScopeRef = useRef(createFileReadScope(workspaceDir));
  if (fileReadScopeRef.current.workspaceDir !== workspaceDir) {
    fileReadScopeRef.current = createFileReadScope(workspaceDir);
  }
  useEffect(() => {
    const scope = fileReadScopeRef.current;
    return () => {
      if (fileReadScopeRef.current === scope) fileReadScopeRef.current = createFileReadScope(workspaceDir);
    };
  }, [workspaceDir]);

  const applyFileUpdateToTabs = useCallback(
    async (update: FileUpdate, ensureOpen: boolean): Promise<void> => {
      const canonicalPath = normalizeWorkspaceRelativePath(update.path, workspaceDir);
      const previousPath = update.previousPath && normalizeWorkspaceRelativePath(update.previousPath, workspaceDir);
      const scope = fileReadScopeRef.current;
      if (!canonicalPath || scope.workspaceDir !== workspaceDir) return;
      const targetRead = beginFileRead(scope, canonicalPath);
      const sourceRead = previousPath ? beginFileRead(scope, previousPath) : null;
      const isCurrent = () => isCurrentFileRead(targetRead, fileReadScopeRef.current)
        && (sourceRead === null || isCurrentFileRead(sourceRead, fileReadScopeRef.current));
      const name = canonicalPath.split("/").pop() || canonicalPath;
      const incoming: FileSnapshot = { content: update.content, source: "assistant_tool" };
      const targetTab = openFilesRef.current.find((file) => isSameWorkspacePath(file.path, canonicalPath, workspaceDir));
      const showsIncoming = !previousPath || ensureOpen;
      const expectedTarget = targetTab
        ? { path: canonicalPath, version: showsIncoming ? applyRemoteFileSnapshot(targetTab, incoming).version : targetTab.version }
        : ensureOpen ? { path: canonicalPath, version: undefined } : null;
      const releaseSource = previousPath ? beginPreserveOpenPath(previousPath) : null;
      // Explicit navigation opens immediately. Metadata only completes the tab
      // that was open for this request, and never reopens or reactivates it.
      if (showsIncoming) {
        setOpenFiles((previous) => {
          if (!isCurrent()) return previous;
          const index = previous.findIndex((file) => isSameWorkspacePath(file.path, canonicalPath, workspaceDir));
          if (index >= 0) return previous.map((file, current) => current === index ? applyRemoteFileSnapshot(file, incoming) : file);
          return ensureOpen ? [...previous, {
            path: canonicalPath,
            name,
            language: getLanguage(name),
            content: update.content,
            modified: false,
            version: undefined,
            updatedAt: undefined,
            ...buildClearedRemoteState(),
          }] : previous;
        });
      }
      const commitSnapshot = (snapshot: FileSnapshot, sourceStatus?: number) => {
        if (!isCurrent()) return;
        const rename = previousPath && update.previousVersion
          ? { previousPath, previousVersion: update.previousVersion, path: canonicalPath, sourceStatus, snapshot }
          : null;
        if (rename && applyRemoteFileRename(openFilesRef.current, rename, workspaceDir) !== openFilesRef.current) {
          setActiveFilePath((path) => isCurrent() && path && isSameWorkspacePath(path, rename.previousPath, workspaceDir) ? canonicalPath : path);
          setEditorNavigationTarget((target) => isCurrent() && target ? { ...target, path: remapMovedPath(target.path, rename.previousPath, canonicalPath) } : target);
          setEditorHighlightTarget((target) => isCurrent() && target ? { ...target, path: remapMovedPath(target.path, rename.previousPath, canonicalPath) } : target);
        }
        setOpenFiles((previous) => {
          if (!isCurrent()) return previous;
          const renamed = rename ? applyRemoteFileRename(previous, rename, workspaceDir) : previous;
          return renamed !== previous ? renamed : applyRemoteFileMetadata(previous, expectedTarget, snapshot, workspaceDir);
        });
      };
      try {
        const [snapshot, sourceStatus] = await Promise.all([
          fs.readFileWithMeta(canonicalPath),
          previousPath ? fs.readFileWithMeta(previousPath).then(() => 200, (error: Error & { status?: number }) => error.status) : undefined,
        ]);
        if (!isCurrent()) return;
        commitSnapshot({ ...snapshot, source: snapshot.source || "assistant_tool" }, sourceStatus);
      } catch {
        // Keep the current buffer when authoritative metadata is unavailable.
      } finally {
        releaseSource?.();
        if (previousPath && scope === fileReadScopeRef.current) void loadTree();
      }
    },
    [beginPreserveOpenPath, fs, loadTree, setActiveFilePath, setEditorHighlightTarget, setEditorNavigationTarget, setOpenFiles, workspaceDir]
  );

  const handleAiFileUpdate = useCallback(
    (update: FileUpdate) => {
      void applyFileUpdateToTabs(update, false);
      if (update.selection && activeFilePath === update.path) {
        highlightRequestRef.current += 1;
        setEditorHighlightTarget({
          path: update.path,
          requestId: highlightRequestRef.current,
          ...update.selection,
        });
      }
      void loadTree();
    },
    [activeFilePath, applyFileUpdateToTabs, highlightRequestRef, loadTree, setEditorHighlightTarget]
  );

  const handleNavigateToFileUpdate = useCallback(
    (update: FileUpdate) => {
      setWorkspaceView("files");
      void applyFileUpdateToTabs(update, true);
      const path = normalizeWorkspaceRelativePath(update.path, workspaceDir);
      setActiveFilePath(path);
      if (update.selection) {
        navigationRequestRef.current += 1;
        setEditorNavigationTarget({ path, requestId: navigationRequestRef.current, ...update.selection });
      }
      void loadTree();
    },
    [applyFileUpdateToTabs, loadTree, navigationRequestRef, setActiveFilePath, setEditorNavigationTarget, setWorkspaceView, workspaceDir]
  );

  const chatAttachmentDraft = useChatAttachmentDraft(token);
  const [chatDraftText, setChatDraftText] = useState("");
  const [contextReferences, setContextReferences] = useState<ContextReference[]>([]);
  const [attachmentSubmissionError, setAttachmentSubmissionError] = useState<string | null>(null);
  const [attachmentSubmissionNotice, setAttachmentSubmissionNotice] = useState<string | null>(null);
  const [pendingAttachmentVerificationIds, setPendingAttachmentVerificationIds] = useState<Set<string>>(() => new Set());
  const [attachmentRetryRequests, setAttachmentRetryRequests] = useState<Array<{ requestId: string; content: string; attachmentIds: string[] }>>([]);

  const handleAttachmentSendRejected = useCallback((rejected: RejectedAttachmentSend) => {
    chatAttachmentDraft.restore(rejected.attachments);
    setChatDraftText((current) => rejected.content
      ? current ? `${rejected.content}\n\n${current}` : rejected.content
      : current);
    setAttachmentSubmissionError(rejected.error);
    setAttachmentSubmissionNotice(null);
    if (rejected.uncertain) {
      setPendingAttachmentVerificationIds((current) => new Set(current).add(rejected.requestId));
    } else {
      setAttachmentRetryRequests((current) => [
        ...current.filter((item) => item.requestId !== rejected.requestId),
        { requestId: rejected.requestId, content: rejected.content, attachmentIds: rejected.attachments.map((attachment: ChatAttachmentRef) => attachment.id) },
      ]);
    }
  }, [chatAttachmentDraft]);

  const handleAttachmentSendReconciled = useCallback((result: AttachmentSendReconciliation) => {
    if (result.status === "persisted" || result.status === "missing") {
      setPendingAttachmentVerificationIds((current) => {
        const next = new Set(current);
        next.delete(result.requestId);
        return next;
      });
    }
    if (result.status === "persisted") {
      setAttachmentRetryRequests((current) => current.filter((item) => item.requestId !== result.requestId));
      chatAttachmentDraft.removeRefs(result.attachments.map((attachment: ChatAttachmentRef) => attachment.id));
      if (result.content) {
        setChatDraftText((current) => {
          if (current === result.content) return "";
          if (current.startsWith(`${result.content}\n\n`)) return current.slice(result.content.length + 2);
          if (current.endsWith(`\n\n${result.content}`)) return current.slice(0, -result.content.length - 2);
          const middle = `\n\n${result.content}\n\n`;
          return current.includes(middle) ? current.replace(middle, "\n\n") : current;
        });
      }
      setAttachmentSubmissionError(null);
      setAttachmentSubmissionNotice(t("chat.attachmentFoundInHistory"));
    } else if (result.status === "missing") {
      setAttachmentRetryRequests((current) => [
        ...current.filter((item) => item.requestId !== result.requestId),
        { requestId: result.requestId, content: result.content, attachmentIds: result.attachments.map((attachment: ChatAttachmentRef) => attachment.id) },
      ]);
      setAttachmentSubmissionError(t("chat.attachmentUnknownSafeRetry"));
      setAttachmentSubmissionNotice(null);
    } else {
      setAttachmentSubmissionError(t(result.status === "processing"
        ? "chat.attachmentStillProcessing"
        : "chat.attachmentStatusUnavailable"));
      setAttachmentSubmissionNotice(null);
    }
  }, [chatAttachmentDraft, t]);

  const chat = useChat(token, workspaceDir, handleAiFileUpdate, handleAttachmentSendRejected, handleAttachmentSendReconciled);

  const selectedChatModelName = chat.selectedModelName
    || chat.runtimeOptions.modeModels[chat.agentMode]
    || chat.runtimeOptions.defaultModelName;
  const selectedChatModelCapabilities = chat.runtimeOptions.modelInputCapabilities[selectedChatModelName];
  const draftReadyAttachmentIds = new Set(chatAttachmentDraft.readyRefs.map((attachment: ChatAttachmentRef) => attachment.id));
  const matchingAttachmentRetries = attachmentRetryRequests.filter((entry) =>
    entry.attachmentIds.some((id) => draftReadyAttachmentIds.has(id))
  );
  const draftAttachmentIdsInOrder = chatAttachmentDraft.readyRefs.map((attachment: ChatAttachmentRef) => attachment.id);
  const matchingRetryIsUnchanged = matchingAttachmentRetries.length === 1
    && chatDraftText.trim() === matchingAttachmentRetries[0].content
    && draftAttachmentIdsInOrder.length === matchingAttachmentRetries[0].attachmentIds.length
    && draftAttachmentIdsInOrder.every((id, index) => id === matchingAttachmentRetries[0].attachmentIds[index]);
  const editedRetryNotice = matchingAttachmentRetries.length === 1 && !matchingRetryIsUnchanged
    ? t("chat.attachmentEditedNewRequest")
    : null;
  const attachmentWarning = pendingAttachmentVerificationIds.size > 0
    ? attachmentSubmissionError || t("chat.attachmentCheckingHistory")
    : matchingAttachmentRetries.length > 1
      ? t("chat.attachmentMultipleRetries")
      : chatAttachmentDraft.readyRefs.some((attachment: ChatAttachmentRef) => attachment.kind === "image")
    && selectedChatModelCapabilities?.supportsImageInput === false
    ? t("chat.attachmentImageUnsupported")
    : chatAttachmentDraft.readyRefs.some((attachment: ChatAttachmentRef) => attachment.kind === "pdf")
      && selectedChatModelCapabilities?.supportsPdfInput === false
      ? t("chat.attachmentPdfUnsupported")
      : null;

  const clearChatConversation = useCallback(() => {
    chatAttachmentDraft.clear();
    setChatDraftText("");
    setContextReferences([]);
    setAttachmentSubmissionError(null);
    setAttachmentSubmissionNotice(null);
    setPendingAttachmentVerificationIds(new Set());
    setAttachmentRetryRequests([]);
    chat.clearMessages();
  }, [chatAttachmentDraft, chat]);

  const loadChatConversation = useCallback((conversationId: string) => {
    chatAttachmentDraft.clear();
    setChatDraftText("");
    setAttachmentSubmissionError(null);
    setAttachmentSubmissionNotice(null);
    setPendingAttachmentVerificationIds(new Set());
    setAttachmentRetryRequests([]);
    return chat.loadConversation(conversationId);
  }, [chatAttachmentDraft, chat]);

  const previousChatConversationIdRef = useRef(chat.currentConversationId);
  useEffect(() => {
    const previousId = previousChatConversationIdRef.current;
    if (previousId !== chat.currentConversationId && previousId !== null) {
      chatAttachmentDraft.clear();
      setChatDraftText("");
      setAttachmentSubmissionError(null);
      setAttachmentSubmissionNotice(null);
      setPendingAttachmentVerificationIds(new Set());
      setAttachmentRetryRequests([]);
    }
    previousChatConversationIdRef.current = chat.currentConversationId;
  }, [chat.currentConversationId]);

  useEffect(() => {
    chatAttachmentDraft.clear();
    setChatDraftText("");
    setContextReferences([]);
    setAttachmentSubmissionError(null);
    setAttachmentSubmissionNotice(null);
    setPendingAttachmentVerificationIds(new Set());
    setAttachmentRetryRequests([]);
  }, [workspaceDir]);

  useEffect(() => {
    if (workspaceView !== "files" || chat.pendingApprovals.length === 0) return;
    setRunDetailsVisible(false);
    setEditorAssistantVisible(true);
  }, [chat.pendingApprovals.length, setEditorAssistantVisible, setRunDetailsVisible, workspaceView]);

  const switchConversation = useCallback(
    (direction: -1 | 1) => {
      if (chat.isStreaming || chat.conversations.length === 0) return;
      const currentIndex = chat.conversations.findIndex(
        (conversation) => conversation.id === chat.currentConversationId
      );
      const startIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (startIndex + direction + chat.conversations.length) % chat.conversations.length;
      void loadChatConversation(chat.conversations[nextIndex].id);
    },
    [chat, loadChatConversation]
  );

  const handleApplyCode = useCallback(
    (code: string) => {
      if (readOnlyWorkspace) {
        showToast(t("team.readOnlyApplyBlocked"));
        return;
      }
      if (!activeFilePath || !editorRef.current) {
        showToast(t("app.noFileOpenToApply"));
        return;
      }
      const editor = editorRef.current;
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) {
        editor.executeEdits("ai-apply", [
          { range: selection, text: code, forceMoveMarkers: true },
        ]);
      } else {
        const model = editor.getModel();
        if (model) {
          const fullRange = model.getFullModelRange();
          editor.executeEdits("ai-apply", [
            { range: fullRange, text: code, forceMoveMarkers: true },
          ]);
        }
      }
      showToast(t("app.codeApplied"));
    },
    [activeFilePath, editorRef, readOnlyWorkspace, showToast, t]
  );

  const handleChatSend = useCallback(
    (message: string, references: ContextReference[] = contextReferences) => {
      if (chatAttachmentDraft.blocked || attachmentWarning) return false;
      const activeFile = openFiles.find((f) => f.path === activeFilePath);
      const context = activeFile
        ? {
            path: activeFile.path,
            content: activeFile.content,
            language: activeFile.language,
            selection: selectionInfo?.text,
            dirty: activeFile.modified,
            selectionRange: selectionInfo
              ? { startLine: selectionInfo.startLine, endLine: selectionInfo.endLine }
              : undefined,
          }
        : undefined;
      const retryRequestId = matchingAttachmentRetries.length === 1
        && message === matchingAttachmentRetries[0].content
        && chatAttachmentDraft.readyRefs.length === matchingAttachmentRetries[0].attachmentIds.length
        && chatAttachmentDraft.readyRefs.every((attachment: ChatAttachmentRef, index: number) => attachment.id === matchingAttachmentRetries[0].attachmentIds[index])
        ? matchingAttachmentRetries[0].requestId
        : undefined;
      const sent = chat.sendMessage(
        message,
        context,
        undefined,
        chatAttachmentDraft.readyRefs,
        retryRequestId,
        references
      );
      if (sent) {
        if (matchingAttachmentRetries.length) {
          const consumedIds = new Set(matchingAttachmentRetries.map((item) => item.requestId));
          setAttachmentRetryRequests((current) => current.filter((item) => !consumedIds.has(item.requestId)));
        }
        chatAttachmentDraft.clear();
        setChatDraftText("");
        setAttachmentSubmissionError(null);
        setAttachmentSubmissionNotice(null);
      }
      return sent;
    },
    [chat, chatAttachmentDraft, attachmentWarning, matchingAttachmentRetries, openFiles, activeFilePath, selectionInfo, contextReferences]
  );

  const handleChatSteer = useCallback(
    (message: string, references: ContextReference[] = contextReferences) => {
      if (pendingAttachmentVerificationIds.size > 0) return false;
      const activeFile = openFiles.find((f) => f.path === activeFilePath);
      const context = activeFile
        ? {
            path: activeFile.path,
            content: activeFile.content,
            language: activeFile.language,
            selection: selectionInfo?.text,
            dirty: activeFile.modified,
            selectionRange: selectionInfo
              ? { startLine: selectionInfo.startLine, endLine: selectionInfo.endLine }
              : undefined,
          }
        : undefined;
      return chat.sendSteering(message, context, undefined, references);
    },
    [chat, pendingAttachmentVerificationIds.size, openFiles, activeFilePath, selectionInfo, contextReferences]
  );

  const handleGitReview = useCallback(() => {
    chat.setAgentMode("review");
    focusChat();
    chat.sendMessage(
      "Review the current Git changes. Identify correctness issues, regressions, missing tests, and give findings ordered by severity.",
      undefined,
      "review"
    );
  }, [chat, focusChat]);

  return {
    chat,
    chatAttachmentDraft,
    chatDraftText,
    setChatDraftText,
    contextReferences,
    setContextReferences,
    attachmentSubmissionError,
    attachmentSubmissionNotice,
    pendingAttachmentVerificationIds,
    attachmentWarning,
    editedRetryNotice,
    clearChatConversation,
    loadChatConversation,
    switchConversation,
    handleApplyCode,
    handleChatSend,
    handleChatSteer,
    handleGitReview,
    applyFileUpdateToTabs,
    handleAiFileUpdate,
    handleNavigateToFileUpdate,
  };
}
