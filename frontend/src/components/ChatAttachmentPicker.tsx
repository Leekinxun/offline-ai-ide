import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileImage, FileText, FileType2, Paperclip, RotateCcw, X } from "lucide-react";
import type { ChatAttachmentRef } from "../types";
import { useI18n } from "../i18n";

export interface ChatDraftAttachment {
  localId: string;
  name: string;
  mimeType: string;
  size: number;
  file?: File;
  status: "uploading" | "ready" | "error";
  ref?: ChatAttachmentRef;
  error?: string;
  previewUrl?: string;
}

export interface ChatAttachmentDraftController {
  attachments: ChatDraftAttachment[];
  readyRefs: ChatAttachmentRef[];
  blocked: boolean;
  add: (files: File[]) => void;
  remove: (localId: string) => void;
  retry: (localId: string) => void;
  restore: (refs: ChatAttachmentRef[]) => void;
  removeRefs: (ids: string[]) => void;
  clear: () => void;
}

interface ChatAttachmentPickerProps {
  attachments: ChatDraftAttachment[];
  onAdd: (files: File[]) => void;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  disabled?: boolean;
  warning?: string | null;
  notice?: string | null;
  checkingDelivery?: boolean;
  onRecheckDelivery?: () => void;
  recheckDisabled?: boolean;
}

const ACCEPTED_FILES = [
  "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/*",
  ".txt", ".md", ".markdown", ".rst", ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonl", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".xml", ".html", ".htm", ".css", ".scss", ".sass",
  ".less", ".sh", ".bash", ".zsh", ".fish", ".sql", ".go", ".rs", ".java",
  ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php",
  ".vue", ".svelte", ".svg", ".csv", ".tsv", ".log", ".diff", ".patch", ".ipynb",
  ".gitignore",
].join(",");
const SAFE_PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ATTACHMENTS = 4;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function isAttachmentRef(value: unknown): value is ChatAttachmentRef {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChatAttachmentRef>;
  return typeof item.id === "string" && !!item.id
    && typeof item.name === "string"
    && typeof item.mimeType === "string"
    && typeof item.size === "number"
    && (item.kind === "image" || item.kind === "text" || item.kind === "pdf");
}

export function useChatAttachmentDraft(token: string): ChatAttachmentDraftController {
  const { t } = useI18n();
  const [attachments, setAttachments] = useState<ChatDraftAttachment[]>([]);
  const attachmentsRef = useRef<ChatDraftAttachment[]>([]);
  const controllersRef = useRef(new Map<string, AbortController>());

  const update = useCallback((next: ChatDraftAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const clear = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    attachmentsRef.current.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
    update([]);
  }, [update]);

  useEffect(() => clear, [clear]);

  const upload = useCallback(async (localId: string) => {
    const attachment = attachmentsRef.current.find((item) => item.localId === localId);
    if (!attachment?.file) return;
    const controller = new AbortController();
    controllersRef.current.set(localId, controller);
    update(attachmentsRef.current.map((item) => item.localId === localId
      ? { ...item, status: "uploading", error: undefined }
      : item));
    const form = new FormData();
    form.append("files", attachment.file, attachment.name);
    try {
      const response = await fetch("/api/chat/attachments", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as {
        attachments?: unknown[];
        error?: string;
        detail?: string;
      };
      if (!response.ok) throw new Error(payload.error || payload.detail || t("chat.attachmentUploadFailed"));
      const ref = payload.attachments?.[0];
      if (!isAttachmentRef(ref)) throw new Error(t("chat.attachmentUploadFailed"));
      if (controller.signal.aborted) return;
      update(attachmentsRef.current.map((item) => item.localId === localId
        ? { ...item, status: "ready", ref, error: undefined }
        : item));
    } catch (error) {
      if (!controller.signal.aborted) {
        update(attachmentsRef.current.map((item) => item.localId === localId
          ? { ...item, status: "error", error: error instanceof Error ? error.message : t("chat.attachmentUploadFailed") }
          : item));
      }
    } finally {
      if (controllersRef.current.get(localId) === controller) controllersRef.current.delete(localId);
    }
  }, [t, token, update]);

  const add = useCallback((files: File[]) => {
    let acceptedCount = attachmentsRef.current.filter((item) => item.status !== "error").length;
    let totalBytes = attachmentsRef.current.reduce((total, item) => total + (item.status === "error" ? 0 : item.size), 0);
    const pending: ChatDraftAttachment[] = files.map((file) => {
      const error = acceptedCount >= MAX_ATTACHMENTS
        ? t("chat.attachmentLimit")
        : totalBytes + file.size > MAX_TOTAL_BYTES
          ? t("chat.attachmentTotalSizeLimit")
          : undefined;
      if (!error) {
        acceptedCount += 1;
        totalBytes += file.size;
      }
      return {
        localId: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type,
        size: file.size,
        file,
        status: error ? "error" : "uploading",
        ...(error ? { error } : {}),
        ...(SAFE_PREVIEW_TYPES.has(file.type) ? { previewUrl: URL.createObjectURL(file) } : {}),
      };
    });
    update([...attachmentsRef.current, ...pending]);
    pending.filter((attachment) => attachment.status === "uploading").forEach((attachment) => void upload(attachment.localId));
  }, [t, update, upload]);

  const remove = useCallback((localId: string) => {
    controllersRef.current.get(localId)?.abort();
    controllersRef.current.delete(localId);
    const attachment = attachmentsRef.current.find((item) => item.localId === localId);
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    update(attachmentsRef.current.filter((item) => item.localId !== localId));
  }, [update]);

  const retry = useCallback((localId: string) => {
    const attachment = attachmentsRef.current.find((item) => item.localId === localId && item.status === "error");
    const accepted = attachmentsRef.current.filter((item) => item.status !== "error");
    const totalBytes = accepted.reduce((total, item) => total + item.size, 0);
    if (!attachment || accepted.length >= MAX_ATTACHMENTS || totalBytes + attachment.size > MAX_TOTAL_BYTES) return;
    if (attachment.ref) {
      update(attachmentsRef.current.map((item) => item.localId === localId
        ? { ...item, status: "ready", error: undefined }
        : item));
    } else if (attachment.file) {
      void upload(localId);
    }
  }, [update, upload]);

  const restore = useCallback((refs: ChatAttachmentRef[]) => {
    const currentIds = new Set(attachmentsRef.current.map((item) => item.ref?.id));
    let acceptedCount = attachmentsRef.current.filter((item) => item.status !== "error").length;
    let totalBytes = attachmentsRef.current.reduce((total, item) => total + (item.status === "error" ? 0 : item.size), 0);
    const restored: ChatDraftAttachment[] = [];
    for (const ref of refs) {
      if (currentIds.has(ref.id)) continue;
      currentIds.add(ref.id);
      const error = acceptedCount >= MAX_ATTACHMENTS
        ? t("chat.attachmentLimit")
        : totalBytes + ref.size > MAX_TOTAL_BYTES
          ? t("chat.attachmentTotalSizeLimit")
          : undefined;
      if (!error) {
        acceptedCount += 1;
        totalBytes += ref.size;
      }
      restored.push({
        localId: crypto.randomUUID(),
        name: ref.name,
        mimeType: ref.mimeType,
        size: ref.size,
        status: error ? "error" : "ready",
        ...(error ? { error } : {}),
        ref,
      });
    }
    if (restored.length) update([...restored, ...attachmentsRef.current]);
  }, [t, update]);

  const removeRefs = useCallback((ids: string[]) => {
    const matchingIds = new Set(ids);
    attachmentsRef.current.forEach((item) => {
      if (!item.ref || !matchingIds.has(item.ref.id)) return;
      controllersRef.current.get(item.localId)?.abort();
      controllersRef.current.delete(item.localId);
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    update(attachmentsRef.current.filter((item) => !item.ref || !matchingIds.has(item.ref.id)));
  }, [update]);

  const readyRefs = useMemo(() => attachments.flatMap((attachment) => attachment.status === "ready" && attachment.ref ? [attachment.ref] : []), [attachments]);
  const blocked = attachments.some((attachment) => attachment.status !== "ready");
  return { attachments, readyRefs, blocked, add, remove, retry, restore, removeRefs, clear };
}

function AttachmentIcon({ kind }: { kind?: ChatAttachmentRef["kind"] }) {
  if (kind === "image") return <FileImage size={15} aria-hidden="true" />;
  if (kind === "pdf") return <FileType2 size={15} aria-hidden="true" />;
  return <FileText size={15} aria-hidden="true" />;
}

function formatFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatAttachmentPicker({ attachments, onAdd, onRemove, onRetry, disabled, warning, notice, checkingDelivery, onRecheckDelivery, recheckDisabled }: ChatAttachmentPickerProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="chat-attachment-picker">
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept={ACCEPTED_FILES}
        multiple
        aria-label={t("chat.attachFiles")}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files || []);
          if (files.length) onAdd(files);
          event.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        className="chat-attachment-add"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        title={t("chat.attachFiles")}
        aria-label={t("chat.attachFiles")}
      >
        <Paperclip size={15} aria-hidden="true" />
        <span>{t("chat.attachFiles")}</span>
      </button>
      {attachments.length > 0 && (
        <div className="chat-attachment-drafts" aria-label={t("chat.attachments")}>
          {attachments.map((attachment) => (
            <div className={`chat-attachment-draft status-${attachment.status}`} key={attachment.localId}>
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" className="chat-attachment-thumbnail" />
              ) : (
                <AttachmentIcon kind={attachment.ref?.kind || (attachment.mimeType.startsWith("image/") ? "image" : attachment.mimeType === "application/pdf" ? "pdf" : "text")} />
              )}
              <span className="chat-attachment-draft-label" title={attachment.name}>
                <strong>{attachment.name}</strong>
                <small>
                  {attachment.status === "uploading"
                    ? t("chat.attachmentUploading")
                    : attachment.status === "error"
                      ? attachment.error || t("chat.attachmentUploadFailed")
                      : formatFileSize(attachment.ref?.size ?? attachment.size)}
                </small>
              </span>
              {attachment.status === "error" && (
                <button type="button" disabled={disabled} onClick={() => onRetry(attachment.localId)} title={t("chat.attachmentRetry")} aria-label={`${t("chat.attachmentRetry")}: ${attachment.name}`}>
                  <RotateCcw size={14} aria-hidden="true" />
                </button>
              )}
              <button type="button" onClick={() => onRemove(attachment.localId)} title={t("chat.attachmentRemove")} aria-label={`${t("chat.attachmentRemove")}: ${attachment.name}`}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      {warning && <div className="chat-attachment-warning" role="alert">{warning}</div>}
      {checkingDelivery && onRecheckDelivery && (
        <button type="button" className="chat-attachment-recheck" onClick={onRecheckDelivery} disabled={recheckDisabled}>
          <RotateCcw size={12} aria-hidden="true" />
          {t("chat.attachmentRecheck")}
        </button>
      )}
      {notice && <div className="chat-attachment-notice" role="status">{notice}</div>}
    </div>
  );
}

interface MessageAttachmentsProps {
  attachments?: ChatAttachmentRef[];
  token: string;
}

function StoredAttachment({ attachment, token }: { attachment: ChatAttachmentRef; token: string }) {
  const { t } = useI18n();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canPreview = attachment.kind === "image" && SAFE_PREVIEW_TYPES.has(attachment.mimeType);

  useEffect(() => {
    if (!canPreview) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetch(`/api/chat/attachments/${encodeURIComponent(attachment.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok) throw new Error(t("chat.attachmentPreviewFailed"));
      return response.blob();
    }).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setPreviewUrl(objectUrl);
    }).catch(() => {
      if (!controller.signal.aborted) setError(t("chat.attachmentPreviewFailed"));
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, canPreview, t, token]);

  const download = async () => {
    try {
      const response = await fetch(`/api/chat/attachments/${encodeURIComponent(attachment.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error();
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = attachment.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setError(null);
    } catch {
      setError(t("chat.attachmentDownloadFailed"));
    }
  };

  return (
    <div className="chat-message-attachment">
      {previewUrl && <img src={previewUrl} alt={attachment.name} className="chat-message-attachment-image" />}
      <button type="button" onClick={() => void download()} title={t("chat.attachmentDownload")}>
        <AttachmentIcon kind={attachment.kind} />
        <span>{attachment.name}</span>
        <small>{formatFileSize(attachment.size)}</small>
      </button>
      {error && <small className="chat-attachment-error" role="alert">{error}</small>}
    </div>
  );
}

export function MessageAttachments({ attachments, token }: MessageAttachmentsProps) {
  const { t } = useI18n();
  if (!attachments?.length) return null;
  return (
    <div className="chat-message-attachments" aria-label={t("chat.attachments")}>
      {attachments.map((attachment) => <StoredAttachment key={attachment.id} attachment={attachment} token={token} />)}
    </div>
  );
}
