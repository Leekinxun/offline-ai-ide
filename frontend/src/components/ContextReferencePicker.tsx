import React, { useEffect, useMemo, useRef, useState } from "react";
import { AtSign, FileCode2, Folder, X } from "lucide-react";
import type { ContextReference, FileNode, SelectionInfo } from "../types";
import { useI18n } from "../i18n";
import { addContextReference, findReferenceMention, referenceCandidates } from "../utils/contextReferences";
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

export function ContextReferenceBadges({ references }: { references?: ContextReference[] }) {
  const { t } = useI18n();
  if (!references?.length) return null;
  return <div className="context-reference-chips" aria-label={t("contextReference.selected")}>
    {references.map((reference) => <span className="context-reference-chip" key={`${reference.kind}:${reference.path || ""}:${reference.symbol || ""}:${reference.range?.startLine || ""}`} title={reference.path}>
      @{reference.symbol ? `${reference.symbol} · ${reference.path}:${reference.range?.startLine}` : reference.path || t(`contextReference.${reference.kind}`)}
    </span>)}
  </div>;
}

export function ContextReferencePicker({ token, workspaceDir, files, references, onChange, value, onValueChange, textareaRef, activeFilePath, selectionInfo }: Props) {
  const { t } = useI18n();
  const [caret, setCaret] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [symbols, setSymbols] = useState<ContextReference[]>([]);
  const [symbolStatus, setSymbolStatus] = useState("");
  const listId = useRef(`reference-picker-${Math.random().toString(36).slice(2)}`).current;
  const mention = findReferenceMention(value, caret);
  const query = mention?.query || "";
  const open = manualOpen || Boolean(mention && dismissed !== `${mention.start}:${query}`);
  const symbolQuery = query.startsWith("symbol:") ? query.slice(7) : null;
  const candidates = useMemo(() => symbolQuery === null ? referenceCandidates(files, query) : symbols, [files, query, symbolQuery, symbols]);
  useEffect(() => {
    setSymbols([]);
    if (!open || symbolQuery === null) { setSymbolStatus(""); return; }
    if (symbolQuery.length < 2) { setSymbolStatus(t("contextReference.symbolHint")); return; }
    const controller = new AbortController();
    let current = true;
    setSymbolStatus(t("contextReference.symbolSearching"));
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ query: symbolQuery, expectedWorkspaceDir: workspaceDir });
      void fetch(`/api/files/context-symbols?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.detail || t("contextReference.symbolFailed"));
          if (!current || payload.workspaceDir !== workspaceDir) return;
          setSymbols(Array.isArray(payload.symbols) ? payload.symbols : []);
          setSymbolStatus(payload.truncated ? t("contextReference.symbolLimited") : "");
        })
        .catch((error) => { if (current && !controller.signal.aborted) setSymbolStatus(error instanceof Error ? error.message : t("contextReference.symbolFailed")); });
    }, 180);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [open, symbolQuery, t, token, workspaceDir]);
  const options = useMemo(() => [
    ...["selection", "problems", "terminal", "symbol"].filter((kind) => !query || kind.includes(query.toLowerCase())).map((kind) => ({
      key: kind,
      label: `@${kind} · ${t(`contextReference.${kind}`)}`,
      reference: { kind, ...(kind === "selection" && activeFilePath ? { path: activeFilePath } : {}) } as ContextReference,
      disabled: kind === "selection" && (!selectionInfo?.text || !activeFilePath) ? t("contextReference.selectionUnavailable") : undefined,
    })),
    ...candidates.map((reference) => ({ key: `${reference.kind}:${reference.path}:${reference.symbol || ""}:${reference.range?.startLine || ""}`, label: reference.symbol ? `${reference.symbol} · ${reference.path}:${reference.range?.startLine}` : reference.path || "", reference, disabled: undefined })),
  ], [activeFilePath, candidates, query, selectionInfo?.text, t]);
  const enabled = options.filter((option) => !option.disabled);
  const active = enabled[Math.min(selectedIndex, Math.max(0, enabled.length - 1))];

  useEffect(() => { setManualOpen(false); setDismissed(null); setCaret(0); }, [workspaceDir]);
  useEffect(() => { setSelectedIndex(0); }, [query, manualOpen]);
  useEffect(() => { setCaret(textareaRef.current?.selectionStart ?? value.length); }, [textareaRef, value]);

  const pick = (reference: ContextReference) => {
    if (reference.kind === "symbol" && !reference.path) {
      const start = mention?.start ?? value.length;
      onValueChange(value.slice(0, start) + "@symbol:" + value.slice(mention?.end ?? value.length));
      setManualOpen(false); setDismissed(null);
      requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(start + 8, start + 8); setCaret(start + 8); });
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
        event.preventDefault(); event.stopPropagation();
        setSelectedIndex((previous) => (previous + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, enabled.length)) % Math.max(1, enabled.length));
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault(); event.stopPropagation();
        if (active && references.length < 16) pick(active.reference);
      } else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setManualOpen(false); setDismissed(mention ? `${mention.start}:${query}` : null);
      }
    };
    textarea.addEventListener("keydown", onKey, true);
    textarea.addEventListener("click", updateCaret);
    textarea.addEventListener("keyup", updateCaret);
    return () => { textarea.removeEventListener("keydown", onKey, true); textarea.removeEventListener("click", updateCaret); textarea.removeEventListener("keyup", updateCaret); };
  });

  return <div className="context-reference-picker">
    <div className="context-reference-toolbar">
      <button type="button" onClick={() => { setManualOpen((previous) => !previous); textareaRef.current?.focus(); }} aria-expanded={open} aria-controls={listId} title={t("contextReference.add")}>
        <AtSign size={13} /> {t("contextReference.add")}
      </button>
      <span>{t("contextReference.hint")}</span>
    </div>
    {references.length > 0 && <div className="context-reference-chips" aria-label={t("contextReference.selected")}>
      {references.map((reference, index) => <span className="context-reference-chip" key={`${reference.kind}:${reference.path || ""}:${reference.symbol || ""}:${reference.range?.startLine || ""}`} title={reference.path}>
        {reference.kind === "folder" ? <Folder size={12} /> : <FileCode2 size={12} />}
        <span>{reference.symbol ? `${reference.symbol} · ${reference.path}:${reference.range?.startLine}` : reference.path || t(`contextReference.${reference.kind}`)}</span>
        <button type="button" aria-label={t("contextReference.remove", { path: reference.path || reference.kind })} onClick={() => onChange(references.filter((_, i) => i !== index))}><X size={12} /></button>
      </span>)}
    </div>}
    {references.length >= 16 && <div role="status">{t("contextReference.limit")}</div>}
    {open && <div className="context-reference-menu" id={listId} role="listbox" aria-label={t("contextReference.add")}>
      {symbolStatus && <div className="context-reference-empty" role="status">{symbolStatus}</div>}
      {!options.length && !symbolStatus && <div className="context-reference-empty">{t("contextReference.empty")}</div>}
      {options.map((option) => <button type="button" role="option" key={option.key} aria-selected={option.key === active?.key} disabled={Boolean(option.disabled) || references.length >= 16} title={option.disabled || option.label} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(option.reference)}>
        {option.reference.kind === "folder" ? <Folder size={14} /> : <FileCode2 size={14} />}
        <span>{option.label}{option.disabled && <small>{option.disabled}</small>}</span>
      </button>)}
    </div>}
  </div>;
}
