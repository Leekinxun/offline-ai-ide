import React, { useMemo, useState } from "react";
import { FileCode2, Send, X } from "lucide-react";
import { AgentMode, ChatMessage, SelectionInfo } from "../types";
import { useI18n } from "../i18n";

interface EditorAssistantPanelProps {
  visible: boolean;
  activeFilePath: string | null;
  selectionInfo: SelectionInfo | null;
  messages: ChatMessage[];
  connected: boolean;
  isStreaming: boolean;
  agentMode: AgentMode;
  onSend: (message: string) => void;
  onSteer: (message: string) => void;
  onClose: () => void;
}

function compactMessage(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[#*_`]/g, "")
    .trim();
}

export const EditorAssistantPanel: React.FC<EditorAssistantPanelProps> = ({
  visible,
  activeFilePath,
  selectionInfo,
  messages,
  connected,
  isStreaming,
  agentMode,
  onSend,
  onSteer,
  onClose,
}) => {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const fileName = activeFilePath?.split("/").pop() || null;
  const visibleMessages = useMemo(
    () => messages.filter((message) => compactMessage(message.content)).slice(-4),
    [messages]
  );

  if (!visible) return null;

  const handleSubmit = () => {
    const message = input.trim();
    if (!message || !connected) return;
    if (isStreaming) onSteer(message);
    else onSend(message);
    setInput("");
  };

  return (
    <aside className="editor-assistant-panel" aria-label={t("workbench.editorAssistant")}> 
      <header className="editor-assistant-header">
        <strong>{t("workbench.editorAssistant")}</strong>
        <button type="button" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
          <X size={15} />
        </button>
      </header>

      <section className="editor-assistant-context">
        <span>{t("workbench.autoAttachedContext")}</span>
        <button type="button" disabled={!activeFilePath} title={activeFilePath || t("workbench.noActiveFile")}>
          <FileCode2 size={14} />
          <strong>{activeFilePath || t("workbench.noActiveFile")}</strong>
          <small>{activeFilePath ? t("workbench.synced") : t("workbench.waiting")}</small>
        </button>
      </section>

      <div className="editor-assistant-messages">
        {visibleMessages.length === 0 ? (
          <article className="editor-assistant-message">
            <div><span>CF</span><strong>CrewForge</strong></div>
            <p>{t("workbench.editorAssistantIntro")}</p>
            <small>
              {fileName
                ? t("workbench.currentFileContext", {
                    file: fileName,
                    selection: selectionInfo
                      ? t("workbench.linesSelected", {
                          start: selectionInfo.startLine,
                          end: selectionInfo.endLine,
                        })
                      : t("workbench.noSelection"),
                  })
                : t("workbench.openFileForContext")}
            </small>
          </article>
        ) : (
          visibleMessages.map((message, index) => (
            <article className={`editor-assistant-message ${message.role}`} key={`${message.timestamp}-${index}`}>
              <div>
                <span>{message.role === "user" ? t("chat.you") : "CF"}</span>
                <strong>{message.role === "user" ? t("chat.you") : "CrewForge"}</strong>
              </div>
              <p>{compactMessage(message.content)}</p>
              {message.role === "user" && activeFilePath && <small>{t("workbench.contextPath", { path: activeFilePath })}</small>}
            </article>
          ))
        )}
      </div>

      <div className="editor-assistant-composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t("workbench.askAboutCurrentFile")}
          aria-label={t("workbench.askAboutCurrentFile")}
        />
        <div>
          <span><FileCode2 size={13} /> {fileName ? t("workbench.fileAttached", { file: fileName }) : t("workbench.noContextAttached")}</span>
          <small>{t(`chat.mode.${agentMode}.label`)}</small>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!input.trim() || !connected}
            title={isStreaming ? t("chat.correct") : t("chat.send")}
            aria-label={isStreaming ? t("chat.correct") : t("chat.send")}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
};
