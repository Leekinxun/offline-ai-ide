import React, { useEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import {
  AtSign,
  FileCode2,
  Folder,
  X,
  TextSelect,
  AlertCircle,
  Terminal,
  Hash,
  Search,
} from "lucide-react";
import type { ContextReference, FileNode, SelectionInfo } from "../types";
import { useI18n } from "../i18n";
import { addContextReference, findReferenceMention, referenceCandidates } from "../utils/contextReferences";
import { getDesktopBridge } from "../desktop/bridge";
import "./ContextReferencePicker.css";

interface Props {
  token: string;
  workspaceDir: string;
  files: FileNode[];
  references: ContextReference[];
  onChange: (references: ContextReference[]) => void;
  value: string;
  onValueChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  activeFilePath?: string | null;
  selectionInfo?: SelectionInfo | null;
}

export interface ContextReferencePickerHandle {
  triggerOpen: () => void;
}

/**
 * 获得引用类型的对应图标
 */
function getReferenceIcon(kind: string, symbol?: string) {
  if (symbol || kind === "symbol") return <Hash size={13} className="context-ref-icon symbol" />;
  if (kind === "selection") return <TextSelect size={13} className="context-ref-icon selection" />;
  if (kind === "problems") return <AlertCircle size={13} className="context-ref-icon problems" />;
  if (kind === "terminal") return <Terminal size={13} className="context-ref-icon terminal" />;
  if (kind === "folder") return <Folder size={13} className="context-ref-icon folder" />;
  return <FileCode2 size={13} className="context-ref-icon file" />;
}

/**
 * 选中引用胶囊（展示在消息详情或输入框下方）
 */
export function ContextReferenceBadges({ references }: { references?: ContextReference[] }) {
  const { t } = useI18n();
  if (!references?.length) return null;
  return (
    <div className="context-reference-chips" aria-label={t("contextReference.selected")}>
      {references.map((reference) => (
        <span
          className="context-reference-chip"
          key={`${reference.kind}:${reference.path || ""}:${reference.symbol || ""}:${reference.range?.startLine || ""}`}
          title={reference.path}
        >
          {getReferenceIcon(reference.kind, reference.symbol)}
          <span className="context-reference-chip-text">
            {reference.symbol
              ? `${reference.symbol} · ${reference.path}:${reference.range?.startLine}`
              : reference.path || t(`contextReference.${reference.kind}`)}
          </span>
        </span>
      ))}
    </div>
  );
}

interface OptionItem {
  key: string;
  category: "context" | "symbol" | "files";
  label: string;
  subLabel?: string;
  reference: ContextReference;
  disabled?: string;
}

export const ContextReferencePicker = forwardRef<ContextReferencePickerHandle, Props>(function ContextReferencePicker(
  { token, workspaceDir, files, references, onChange, value, onValueChange, textareaRef, activeFilePath, selectionInfo },
  ref
) {
  const { t } = useI18n();
  const [caret, setCaret] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [symbols, setSymbols] = useState<ContextReference[]>([]);
  const [symbolStatus, setSymbolStatus] = useState("");
  const [remoteFileReferences, setRemoteFileReferences] = useState<ContextReference[]>([]);
  const [fileStatus, setFileStatus] = useState("");
  const listId = useRef(`reference-picker-${Math.random().toString(36).slice(2)}`).current;

  // 暴露给外部（例如底栏 @ 按钮）手动打开选择器
  useImperativeHandle(ref, () => ({
    triggerOpen: () => {
      setManualOpen(true);
      setDismissed(null);
      textareaRef.current?.focus();
    },
  }));

  const mention = findReferenceMention(value, caret);
  const query = mention?.query || "";
  const open = manualOpen || Boolean(mention && dismissed !== `${mention.start}:${query}`);
  const symbolQuery = query.startsWith("symbol:") ? query.slice(7) : null;
  const localFileCandidates = useMemo(() => referenceCandidates(files, query), [files, query]);
  const fileCandidates = useMemo(() => {
    if (symbolQuery !== null) return [];
    const seen = new Set(localFileCandidates.map((reference) => `${reference.kind}:${reference.path || ""}`));
    return [
      ...localFileCandidates,
      ...remoteFileReferences.filter((reference) => {
        const key = `${reference.kind}:${reference.path || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    ];
  }, [localFileCandidates, remoteFileReferences, symbolQuery]);
  const candidates = symbolQuery === null ? fileCandidates : symbols;

  useEffect(() => {
    setSymbols([]);
    if (!open || symbolQuery === null) {
      setSymbolStatus("");
      return;
    }
    if (symbolQuery.length < 2) {
      setSymbolStatus(t("contextReference.symbolHint"));
      return;
    }
    const controller = new AbortController();
    let current = true;
    setSymbolStatus(t("contextReference.symbolSearching"));
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ query: symbolQuery, expectedWorkspaceDir: workspaceDir });
      void fetch(`/api/files/context-symbols?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.detail || t("contextReference.symbolFailed"));
          if (!current || payload.workspaceDir !== workspaceDir) return;
          setSymbols(Array.isArray(payload.symbols) ? payload.symbols : []);
          setSymbolStatus(payload.truncated ? t("contextReference.symbolLimited") : "");
        })
        .catch((error) => {
          if (current && !controller.signal.aborted) {
            setSymbolStatus(error instanceof Error ? error.message : t("contextReference.symbolFailed"));
          }
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, symbolQuery, t, token, workspaceDir]);

  useEffect(() => {
    setRemoteFileReferences([]);
    if (
      !open ||
      symbolQuery !== null ||
      getDesktopBridge()?.workspaceChanges !== "cursor"
    ) {
      setFileStatus("");
      return;
    }
    const normalized = query.trim();
    if (!normalized) {
      setFileStatus("");
      return;
    }
    const controller = new AbortController();
    let current = true;
    setFileStatus(t("contextReference.fileSearching"));
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ query: normalized, expectedWorkspaceDir: workspaceDir });
      void fetch(`/api/files/paths?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.detail || t("contextReference.fileFailed"));
          if (!current || (typeof payload.workspaceDir === "string" && payload.workspaceDir !== workspaceDir)) return;
          const paths: string[] = Array.isArray(payload.paths)
            ? payload.paths.filter((path: unknown): path is string => typeof path === "string")
            : [];
          setRemoteFileReferences(paths.map((path) => ({ kind: "file", path } as ContextReference)));
          setFileStatus(payload.truncated ? t("contextReference.fileLimited") : "");
        })
        .catch((error) => {
          if (current && !controller.signal.aborted) {
            setFileStatus(error instanceof Error ? error.message : t("contextReference.fileFailed"));
          }
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, symbolQuery, t, token, workspaceDir]);

  // 将候选分组：工作区上下文、符号、文件与目录
  const { options, categorizedGroups } = useMemo(() => {
    const list: OptionItem[] = [];

    // 1. 工作区上下文候选
    const contextKinds = ["selection", "problems", "terminal"] as const;
    contextKinds
      .filter((kind) => !query || kind.includes(query.toLowerCase()))
      .forEach((kind) => {
        list.push({
          key: `ctx:${kind}`,
          category: "context",
          label: `@${kind}`,
          subLabel: t(`contextReference.${kind}`),
          reference: { kind, ...(kind === "selection" && activeFilePath ? { path: activeFilePath } : {}) } as ContextReference,
          disabled: kind === "selection" && (!selectionInfo?.text || !activeFilePath) ? t("contextReference.selectionUnavailable") : undefined,
        });
      });

    // 2. 符号入口或符号结果
    if (symbolQuery === null) {
      if (!query || "symbol".includes(query.toLowerCase())) {
        list.push({
          key: "ctx:symbol",
          category: "symbol",
          label: "@symbol",
          subLabel: t("contextReference.symbol"),
          reference: { kind: "symbol" } as ContextReference,
          disabled: undefined,
        });
      }
    } else {
      candidates.forEach((reference) => {
        list.push({
          key: `sym:${reference.path}:${reference.symbol || ""}:${reference.range?.startLine || ""}`,
          category: "symbol",
          label: reference.symbol || "",
          subLabel: `${reference.path}:${reference.range?.startLine}`,
          reference,
          disabled: undefined,
        });
      });
    }

    // 3. 文件与目录候选（非符号搜索模式下）
    if (symbolQuery === null) {
      candidates.forEach((reference) => {
        list.push({
          key: `file:${reference.kind}:${reference.path}`,
          category: "files",
          label: reference.path?.split("/").pop() || reference.path || "",
          subLabel: reference.path || "",
          reference,
          disabled: undefined,
        });
      });
    }

    // 结构化分组用于渲染分类标题
    const groups: { category: "context" | "symbol" | "files"; title: string; items: OptionItem[] }[] = [];
    const contextItems = list.filter((item) => item.category === "context");
    if (contextItems.length) groups.push({ category: "context", title: "工作区上下文", items: contextItems });

    const symbolItems = list.filter((item) => item.category === "symbol");
    if (symbolItems.length) groups.push({ category: "symbol", title: "代码符号", items: symbolItems });

    const fileItems = list.filter((item) => item.category === "files");
    if (fileItems.length) groups.push({ category: "files", title: "文件与目录", items: fileItems });

    return { options: list, categorizedGroups: groups };
  }, [activeFilePath, candidates, query, selectionInfo?.text, symbolQuery, t]);

  const enabled = options.filter((option) => !option.disabled);
  const active = enabled[Math.min(selectedIndex, Math.max(0, enabled.length - 1))];

  useEffect(() => {
    setManualOpen(false);
    setDismissed(null);
    setCaret(0);
  }, [workspaceDir]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, manualOpen]);

  useEffect(() => {
    setCaret(textareaRef.current?.selectionStart ?? value.length);
  }, [textareaRef, value]);

  const pick = (reference: ContextReference) => {
    if (reference.kind === "symbol" && !reference.path) {
      const start = mention?.start ?? value.length;
      onValueChange(value.slice(0, start) + "@symbol:" + value.slice(mention?.end ?? value.length));
      setManualOpen(false);
      setDismissed(null);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(start + 8, start + 8);
        setCaret(start + 8);
      });
      return;
    }
    onChange(addContextReference(references, reference));
    const nextValue = mention ? value.slice(0, mention.start) + value.slice(mention.end) : value;
    if (mention) onValueChange(nextValue);
    setManualOpen(false);
    setDismissed(mention ? `${mention.start}:${query}` : null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      const position = mention?.start ?? nextValue.length;
      textarea?.setSelectionRange(position, position);
      setCaret(position);
    });
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const updateCaret = () => setCaret(textarea.selectionStart);
    const onKey = (event: KeyboardEvent) => {
      if (!open || event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(
          (previous) =>
            (previous + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, enabled.length)) %
            Math.max(1, enabled.length)
        );
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        if (active && references.length < 16) pick(active.reference);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setManualOpen(false);
        setDismissed(mention ? `${mention.start}:${query}` : null);
      }
    };
    textarea.addEventListener("keydown", onKey, true);
    textarea.addEventListener("click", updateCaret);
    textarea.addEventListener("keyup", updateCaret);
    return () => {
      textarea.removeEventListener("keydown", onKey, true);
      textarea.removeEventListener("click", updateCaret);
      textarea.removeEventListener("keyup", updateCaret);
    };
  });

  return (
    <div className="context-reference-picker">
      {/* 仅在有引用时展示已选胶囊，彻底移除原死板整行 toolbar */}
      {references.length > 0 && (
        <div className="context-reference-chips" aria-label={t("contextReference.selected")}>
          {references.map((reference, index) => (
            <span
              className="context-reference-chip"
              key={`${reference.kind}:${reference.path || ""}:${reference.symbol || ""}:${reference.range?.startLine || ""}`}
              title={reference.path}
            >
              {getReferenceIcon(reference.kind, reference.symbol)}
              <span className="context-reference-chip-text">
                {reference.symbol
                  ? `${reference.symbol} · ${reference.path}:${reference.range?.startLine}`
                  : reference.path || t(`contextReference.${reference.kind}`)}
              </span>
              <button
                type="button"
                className="context-reference-chip-remove"
                aria-label={t("contextReference.remove", { path: reference.path || reference.kind })}
                onClick={() => onChange(references.filter((_, i) => i !== index))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {references.length >= 16 && (
        <div className="context-reference-limit-notice" role="status">
          {t("contextReference.limit")}
        </div>
      )}

      {/* 弹出菜单：仿现代 IDE 分类分组与微光质感 */}
      {open && (
        <div className="context-reference-menu" id={listId} role="listbox" aria-label={t("contextReference.add")}>
          <div className="context-reference-menu-header">
            <span className="context-reference-menu-title">
              <AtSign size={12} />
              <span>引用上下文</span>
            </span>
            {query && (
              <span className="context-reference-menu-query">
                <Search size={11} />
                <code>{query}</code>
              </span>
            )}
          </div>

          <div className="context-reference-menu-body">
            {symbolStatus && <div className="context-reference-empty" role="status">{symbolStatus}</div>}
            {!symbolStatus && fileStatus && <div className="context-reference-empty" role="status">{fileStatus}</div>}
            {!options.length && !symbolStatus && !fileStatus && (
              <div className="context-reference-empty">{t("contextReference.empty")}</div>
            )}

            {categorizedGroups.map((group) => (
              <div className="context-reference-group" key={group.category}>
                <div className="context-reference-group-title">{group.title}</div>
                {group.items.map((option) => {
                  const isSelected = option.key === active?.key;
                  return (
                    <button
                      type="button"
                      role="option"
                      key={option.key}
                      className={`context-reference-option${isSelected ? " active" : ""}`}
                      aria-selected={isSelected}
                      disabled={Boolean(option.disabled) || references.length >= 16}
                      title={option.disabled || option.label}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(option.reference)}
                    >
                      <div className="context-reference-option-icon">
                        {getReferenceIcon(option.reference.kind, option.reference.symbol)}
                      </div>
                      <div className="context-reference-option-content">
                        <span className="context-reference-option-label">{option.label}</span>
                        {option.subLabel && (
                          <span className="context-reference-option-sub">{option.subLabel}</span>
                        )}
                        {option.disabled && (
                          <span className="context-reference-option-disabled-hint">{option.disabled}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="context-reference-footer">
            <span className="context-reference-footer-left">
              <span>键入搜索文件、符号与诊断</span>
            </span>
            <span className="context-reference-footer-right">
              <span>↑↓ 导航</span>
              <span>Enter 选用</span>
              <span>Esc 关闭</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
});
