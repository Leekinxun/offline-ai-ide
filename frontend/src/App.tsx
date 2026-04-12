import React, { useState, useEffect, useCallback, useRef } from "react";
import * as monaco from "monaco-editor";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { Editor } from "./components/Editor";
import { ChatPanel } from "./components/ChatPanel";
import { StatusBar } from "./components/StatusBar";
import { Terminal } from "./components/Terminal";
import { LoginPage } from "./components/LoginPage";
import { useFileSystem } from "./hooks/useFileSystem";
import { useChat } from "./hooks/useChat";
import { useAuth } from "./hooks/useAuth";
import { FileNode, OpenFile, SelectionInfo, getLanguage } from "./types";
import {
  PanelLeft,
  MessageSquare,
  TerminalSquare,
  Code2,
  LogOut,
} from "lucide-react";
import "./App.css";

export default function App() {
  const auth = useAuth();

  // Show loading while validating token
  if (auth.loading) {
    return (
      <div className="login-page">
        <div className="login-card" style={{ textAlign: "center", padding: 40 }}>
          <Code2 size={32} style={{ color: "var(--accent)", marginBottom: 12 }} />
          <div style={{ color: "var(--text-secondary)" }}>Loading...</div>
        </div>
      </div>
    );
  }

  // Show login if not authenticated
  if (!auth.token || !auth.user) {
    return <LoginPage onLogin={auth.login} />;
  }

  return (
    <AuthenticatedApp
      token={auth.token}
      username={auth.user.username}
      workspaceDir={auth.user.workspaceDir}
      onLogout={auth.logout}
      onChangeWorkspace={auth.changeWorkspace}
    />
  );
}

interface AuthenticatedAppProps {
  token: string;
  username: string;
  workspaceDir: string;
  onLogout: () => void;
  onChangeWorkspace: (path: string) => Promise<boolean>;
}

function AuthenticatedApp({
  token,
  username,
  workspaceDir,
  onLogout,
  onChangeWorkspace,
}: AuthenticatedAppProps) {
  // --- State ---
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [chatVisible, setChatVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });
  const [toast, setToast] = useState<string | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [chatWidth, setChatWidth] = useState(340);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const draggingRef = useRef<"sidebar" | "chat" | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const fs = useFileSystem(token);
  const chat = useChat(token);

  // --- Resize drag handling ---
  const handleResizeStart = useCallback(
    (panel: "sidebar" | "chat", e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = panel;
      startXRef.current = e.clientX;
      startWidthRef.current = panel === "sidebar" ? sidebarWidth : chatWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth, chatWidth]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      if (draggingRef.current === "sidebar") {
        setSidebarWidth(Math.max(150, Math.min(500, startWidthRef.current + delta)));
      } else {
        setChatWidth(Math.max(250, Math.min(600, startWidthRef.current - delta)));
      }
    };
    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // --- Load file tree ---
  const loadTree = useCallback(async () => {
    try {
      const tree = await fs.fetchTree();
      setFileTree(tree);
    } catch {
      showToast("Failed to load file tree");
    }
  }, [fs]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // Reset state when workspace changes
  useEffect(() => {
    setOpenFiles([]);
    setActiveFilePath(null);
    loadTree();
  }, [workspaceDir]);

  // --- Toast ---
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // --- File operations ---
  const openFile = useCallback(
    async (path: string) => {
      const existing = openFiles.find((f) => f.path === path);
      if (existing) {
        setActiveFilePath(path);
        return;
      }

      try {
        const content = await fs.readFile(path);
        const name = path.split("/").pop() || path;
        const language = getLanguage(name);
        const newFile: OpenFile = {
          path,
          name,
          content,
          language,
          modified: false,
        };
        setOpenFiles((prev) => [...prev, newFile]);
        setActiveFilePath(path);
      } catch {
        showToast("Failed to open file");
      }
    },
    [openFiles, fs, showToast]
  );

  const closeTab = useCallback(
    (path: string) => {
      setOpenFiles((prev) => {
        const filtered = prev.filter((f) => f.path !== path);
        if (activeFilePath === path) {
          setActiveFilePath(
            filtered.length > 0 ? filtered[filtered.length - 1].path : null
          );
        }
        return filtered;
      });
    },
    [activeFilePath]
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      if (!activeFilePath) return;
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === activeFilePath
            ? { ...f, content: value, modified: true }
            : f
        )
      );
    },
    [activeFilePath]
  );

  const saveFile = useCallback(async () => {
    const file = openFiles.find((f) => f.path === activeFilePath);
    if (!file) return;
    try {
      await fs.writeFile(file.path, file.content);
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === activeFilePath ? { ...f, modified: false } : f
        )
      );
      showToast("File saved");
    } catch {
      showToast("Failed to save file");
    }
  }, [activeFilePath, openFiles, fs, showToast]);

  const handleCreateEntry = useCallback(
    async (path: string, isDirectory: boolean) => {
      await fs.createEntry(path, isDirectory);
    },
    [fs]
  );

  const handleDeleteEntry = useCallback(
    async (path: string) => {
      await fs.deleteEntry(path);
      setOpenFiles((prev) => prev.filter((f) => f.path !== path));
      if (activeFilePath === path) {
        setActiveFilePath(null);
      }
    },
    [fs, activeFilePath]
  );

  const handleRenameEntry = useCallback(
    async (oldPath: string, newPath: string) => {
      await fs.renameEntry(oldPath, newPath);
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === oldPath
            ? {
                ...f,
                path: newPath,
                name: newPath.split("/").pop() || newPath,
                language: getLanguage(newPath.split("/").pop() || ""),
              }
            : f
        )
      );
      if (activeFilePath === oldPath) {
        setActiveFilePath(newPath);
      }
    },
    [fs, activeFilePath]
  );

  // --- Selection tracking ---
  const handleSelectionChange = useCallback(
    (selection: SelectionInfo | null) => {
      setSelectionInfo(selection);
    },
    []
  );

  // --- Chat: apply code to editor ---
  const handleApplyCode = useCallback(
    (code: string) => {
      if (!activeFilePath || !editorRef.current) {
        showToast("No file open to apply code to");
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
      showToast("Code applied");
    },
    [activeFilePath, showToast]
  );

  // --- Chat: send with file + selection context ---
  const handleChatSend = useCallback(
    (message: string) => {
      const activeFile = openFiles.find((f) => f.path === activeFilePath);
      const context = activeFile
        ? {
            path: activeFile.path,
            content: activeFile.content,
            language: activeFile.language,
            selection: selectionInfo?.text,
          }
        : undefined;
      chat.sendMessage(message, context);
    },
    [chat, openFiles, activeFilePath, selectionInfo]
  );

  // --- Track cursor position ---
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const disposable = editor.onDidChangeCursorPosition((e) => {
      setCursorPos({ line: e.position.lineNumber, column: e.position.column });
    });
    return () => disposable.dispose();
  });

  // --- Handle workspace change ---
  const handleChangeWorkspace = useCallback(
    async (path: string) => {
      const ok = await onChangeWorkspace(path);
      if (ok) {
        showToast("Workspace changed");
      } else {
        showToast("Failed to change workspace");
      }
    },
    [onChangeWorkspace, showToast]
  );

  // --- Global keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setSidebarVisible((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        setChatVisible((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        setTerminalVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // --- Derived ---
  const activeFile = openFiles.find((f) => f.path === activeFilePath) || null;

  return (
    <div className="app">
      {/* Title Bar */}
      <div className="titlebar">
        <div className="titlebar-left">
          <Code2 size={18} style={{ color: "var(--accent)" }} />
          <span className="titlebar-logo">AI IDE</span>
        </div>
        <div className="titlebar-right">
          <span className="user-badge">{username}</span>
          <button
            className={`titlebar-btn${sidebarVisible ? " active" : ""}`}
            onClick={() => setSidebarVisible((v) => !v)}
            title="Toggle Sidebar (Cmd+B)"
          >
            <PanelLeft size={17} />
          </button>
          <button
            className={`titlebar-btn${terminalVisible ? " active" : ""}`}
            onClick={() => setTerminalVisible((v) => !v)}
            title="Toggle Terminal (Cmd+`)"
          >
            <TerminalSquare size={17} />
          </button>
          <button
            className={`titlebar-btn${chatVisible ? " active" : ""}`}
            onClick={() => setChatVisible((v) => !v)}
            title="Toggle AI Chat (Cmd+J)"
          >
            <MessageSquare size={17} />
          </button>
          <button
            className="titlebar-btn"
            onClick={onLogout}
            title="Logout"
          >
            <LogOut size={17} />
          </button>
        </div>
      </div>

      {/* Main Layout */}
      <div className="main-layout">
        <Sidebar
          tree={fileTree}
          activeFilePath={activeFilePath}
          visible={sidebarVisible}
          onFileSelect={openFile}
          onCreateEntry={handleCreateEntry}
          onDeleteEntry={handleDeleteEntry}
          onRenameEntry={handleRenameEntry}
          onRefreshTree={loadTree}
          workspaceDir={workspaceDir}
          onChangeWorkspace={handleChangeWorkspace}
          token={token}
          style={sidebarVisible ? { width: sidebarWidth } : undefined}
        />

        <div
          className={`resize-handle${!sidebarVisible ? " hidden" : ""}${draggingRef.current === "sidebar" ? " dragging" : ""}`}
          onMouseDown={(e) => handleResizeStart("sidebar", e)}
        />

        <div className="editor-area">
          <TabBar
            openFiles={openFiles}
            activeFilePath={activeFilePath}
            onSelectTab={setActiveFilePath}
            onCloseTab={closeTab}
          />
          <div className="editor-main">
            {activeFile ? (
              <Editor
                content={activeFile.content}
                language={activeFile.language}
                path={activeFile.path}
                onChange={handleEditorChange}
                onSave={saveFile}
                onSelectionChange={handleSelectionChange}
                editorRef={editorRef}
              />
            ) : (
              <div className="editor-empty">
                <Code2 className="editor-empty-icon" size={48} />
                <span className="editor-empty-text">
                  Open a file to start editing
                </span>
              </div>
            )}
          </div>
          <Terminal
            key={workspaceDir}
            visible={terminalVisible}
            token={token}
          />
        </div>

        <div
          className={`resize-handle${!chatVisible ? " hidden" : ""}${draggingRef.current === "chat" ? " dragging" : ""}`}
          onMouseDown={(e) => handleResizeStart("chat", e)}
        />

        <ChatPanel
          messages={chat.messages}
          isStreaming={chat.isStreaming}
          connected={chat.connected}
          visible={chatVisible}
          selectionInfo={selectionInfo}
          activeFileName={activeFile?.name || null}
          onSend={handleChatSend}
          onClear={chat.clearMessages}
          onApplyCode={handleApplyCode}
          style={chatVisible ? { width: chatWidth } : undefined}
        />
      </div>

      {/* Status Bar */}
      <StatusBar
        activeFile={
          activeFile
            ? { path: activeFile.path, language: activeFile.language }
            : null
        }
        cursorPosition={cursorPos}
        connected={chat.connected}
      />

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
