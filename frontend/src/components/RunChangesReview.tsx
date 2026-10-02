import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { editor, IDisposable } from "monaco-editor";
import { Check, ChevronDown, ExternalLink, MessageSquare, RefreshCw, Undo2 } from "lucide-react";
import { useI18n } from "../i18n";
import { useRunChanges } from "../hooks/useRunChanges";
import { getEditorThemeName } from "../editor/themeNames";
import { DEFAULT_EDITOR_FONT_FAMILY, DEFAULT_EDITOR_FONT_OPTIONS } from "../editor/fontDefaults";
import { getLanguage } from "../types";
import { binaryEvidenceForFile, bulkReviewPolicy, reviewActionPolicy, reviewStatus, validReviewComment, type RunReviewComment, type ReviewFile, type ReviewHunk } from "./runReviewPolicy";
import "./RunChangesReview.css";

const DiffEditor = lazy(() => import("@monaco-editor/react").then((module) => ({ default: module.DiffEditor })));
export type { RunReviewComment } from "./runReviewPolicy";
export interface RunChangesReviewProps {
  token: string; workspaceDir?: string; runId?: string; requestId?: string;
  theme?: "light" | "dark"; readOnly?: boolean; running?: boolean; refreshKey?: string | number;
  compact?: boolean; onOpenFile: (path: string) => void; onOpenDiff?: (path: string, runId?: string) => void;
  onComment?: (comment: RunReviewComment) => void; onChanged?: () => void;
}
type LineSelection = { side: "original" | "modified"; startLine: number; endLine: number };

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number") return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function BinaryReviewPanel({ file }: { file: ReviewFile }) {
  const { t } = useI18n();
  const evidence = binaryEvidenceForFile(file);
  const rows = [
    file.originalExists || evidence.originalHash || typeof evidence.originalSize === "number"
      ? { key: "original", label: t("review.original"), hash: evidence.originalHash, bytes: evidence.originalSize }
      : null,
    file.modifiedExists || evidence.modifiedHash || typeof evidence.modifiedSize === "number"
      ? { key: "modified", label: t("review.modified"), hash: evidence.modifiedHash, bytes: evidence.modifiedSize }
      : null,
  ].filter(Boolean) as Array<{ key: string; label: string; hash?: string; bytes?: number }>;
  return <div className="run-review-binary" role="note">
    <div>
      <strong>{t("review.binaryTitle")}</strong>
      <p>{t(evidence.complete ? "review.binaryDescription" : "review.binaryUnavailable")}</p>
    </div>
    <dl className="run-review-binary-grid">
      {rows.map((row) => <div key={row.key}>
        <dt>{row.label}</dt>
        <dd><span>{t("review.binaryBytes", { size: formatBytes(row.bytes) })}</span><code title={row.hash || undefined}>{row.hash || "—"}</code></dd>
      </div>)}
    </dl>
    <small>{t("review.binaryNoComments")}</small>
  </div>;
}

function ReviewCanvas({ file, theme, onSelection }: { file: ReviewFile; theme: "light" | "dark"; onSelection: (selection: LineSelection) => void }) {
  const { t } = useI18n();
  const subscriptions = useRef<IDisposable[]>([]);
  useEffect(() => () => { subscriptions.current.forEach((subscription) => subscription.dispose()); }, []);
  const mount = (diff: editor.IStandaloneDiffEditor) => {
    subscriptions.current.forEach((subscription) => subscription.dispose());
    subscriptions.current = (["original", "modified"] as const).map((side) => {
      const pane = side === "original" ? diff.getOriginalEditor() : diff.getModifiedEditor();
      return pane.onDidChangeCursorSelection(({ selection }) => {
        if (!pane.hasTextFocus()) return;
        onSelection({ side, startLine: selection.startLineNumber, endLine: selection.endLineNumber });
      });
    });
  };
  return <div className="run-review-canvas" aria-label={t("review.diffLabel", { path: file.path })}>
    <Suspense fallback={<div className="run-review-notice">{t("review.loading")}</div>}>
      <DiffEditor original={file.original} modified={file.modified} language={getLanguage(file.path)}
        theme={getEditorThemeName(theme)} onMount={mount}
        options={{ ...DEFAULT_EDITOR_FONT_OPTIONS, fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
          readOnly: true, originalEditable: false, renderSideBySide: false, automaticLayout: true,
          minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: "on",
          renderOverviewRuler: true, accessibilitySupport: "auto" }} />
    </Suspense>
  </div>;
}

export function RunChangesReview({ token, workspaceDir, runId, requestId, theme = "dark", readOnly = false, running = false, refreshKey, compact = false, onOpenFile, onOpenDiff, onComment, onChanged }: RunChangesReviewProps) {
  const { t } = useI18n();
  const review = useRunChanges({ token, workspaceDir, runId, requestId, running, refreshKey, onChanged });
  const [selection, setSelection] = useState<LineSelection>({ side: "modified", startLine: 1, endLine: 1 });
  const [comment, setComment] = useState("");
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentRevision, setCommentRevision] = useState<string | null>(null);
  const [commentSent, setCommentSent] = useState(false);
  const file = review.file;
  useEffect(() => {
    setSelection({ side: "modified", startLine: 1, endLine: 1 }); setComment(""); setCommentOpen(false); setCommentRevision(null); setCommentSent(false);
  }, [runId, requestId, workspaceDir, review.selectedPath]);
  const policy = file ? reviewActionPolicy(file, { readOnly, running, busy: review.busy, stale: review.stale || review.detailLoading }) : null;
  const bulk = bulkReviewPolicy(review.changes, { readOnly, busy: review.busy, loading: review.loading });
  const submitComment = () => {
    if (!file || !onComment || !policy?.comment || commentRevision !== file.revision) return;
    const payload = { path: file.path, revision: file.revision, ...selection, text: comment.trim() };
    if (!validReviewComment(file, payload)) return;
    onComment(payload); setComment(""); setCommentOpen(false); setCommentSent(true);
  };
  const hunkButtons = (hunk: ReviewHunk) => {
    if (!file || readOnly) return null;
    const enabled = reviewActionPolicy(file, { readOnly, running, busy: review.busy, stale: review.stale || review.detailLoading }, hunk);
    return <span className="run-review-actions">
      <button type="button" disabled={!enabled.keep} onClick={() => void review.decide(file, "keep", hunk)}><Check size={12} />{t("review.keepHunk")}</button>
      <button type="button" disabled={!enabled.revert} title={running ? t("review.stopBeforeUndo") : undefined} onClick={() => void review.decide(file, "revert", hunk)}><Undo2 size={12} />{t("review.undoHunk")}</button>
    </span>;
  };
  if (!runId) return <div className="run-review-notice">{t("review.noRun")}</div>;
  return <section className={`run-review${compact ? " compact" : ""}`} aria-label={t("review.title")} aria-busy={review.busy}>
    <header className="run-review-heading"><strong>{t("review.title")}</strong><span>{review.changes?.files.length || 0}</span>
      <button type="button" onClick={() => { review.clearError(); void review.retry(); }} disabled={review.loading || review.busy} aria-label={t("review.refresh")}><RefreshCw size={13} /></button>
    </header>
    {!readOnly && bulk.count > 0 && <div className="run-review-bulk">
      <button type="button" className="run-review-keep-all" disabled={!bulk.allowed}
        title={t(bulk.unavailable ? "review.keepAllUnavailable" : "review.keepAllHint")}
        onClick={() => { if (bulk.allowed && review.changes) void review.keepAll(review.changes); }}>
        <Check size={14} />{review.busy ? t("review.keepingAll") : t("review.keepAll", { count: bulk.count })}
      </button>
      <span>{t(bulk.unavailable ? "review.keepAllUnavailable" : "review.keepAllHint")}</span>
    </div>}
    <p className="run-review-description">{t("review.appliedHint")}</p>
    {running && <p className="run-review-notice" role="status">{t("review.runningHint")}</p>}
    {review.error && <div className="run-review-error" role="alert">{review.error}</div>}
    {review.loading && !review.changes && <div className="run-review-notice">{t("review.loading")}</div>}
    {!review.loading && !review.changes?.files.length && <div className="run-review-notice">{review.changes?.unavailableReason ? t("review.evidenceUnavailable") : t("review.empty")}</div>}
    <div className="run-review-files" role="group" aria-label={t("review.files")}>
      {review.changes?.files.map((entry) => <button key={entry.path} type="button"
        className={review.selectedPath === entry.path ? "selected" : ""} aria-pressed={review.selectedPath === entry.path}
        onClick={() => review.setSelectedPath(entry.path)}>
        <span className="run-review-file-name">{entry.path}</span>
        <span className="run-review-stats">{entry.isBinary ? <span>{t("review.binaryBadge")}</span> : <><span className="added">+{entry.additions ?? "—"}</span><span className="removed">−{entry.deletions ?? "—"}</span></>}</span>
        <small className={`run-review-state ${reviewStatus(entry)}`}>{t(`review.state.${reviewStatus(entry)}`)}</small>
      </button>)}
    </div>
    {file && <article className="run-review-detail">
      <header className="run-review-file-heading"><strong>{file.path}</strong><code title={file.revision}>{file.revision.slice(0, 10)}</code></header>
      <div className="run-review-actions">
        <button type="button" onClick={() => onOpenFile(file.path)} disabled={!file.modifiedExists}><ExternalLink size={12} />{t("review.openFile")}</button>
        {onOpenDiff && <button type="button" onClick={() => onOpenDiff(file.path, runId)}>{t("review.expandDiff")}</button>}
        {!readOnly && <>
          <button type="button" disabled={!policy?.keep} onClick={() => void review.decide(file, "keep")}><Check size={12} />{t("review.keepFile")}</button>
          <button type="button" disabled={!policy?.revert} title={running ? t("review.stopBeforeUndo") : undefined} onClick={() => void review.decide(file, "revert")}><Undo2 size={12} />{t("review.undoFile")}</button>
        </>}
      </div>
      {review.stale && <div className="run-review-notice" role="status">{t("review.updating")}</div>}
      {file.unavailableReason ? <div className="run-review-error">{t("review.evidenceUnavailable")}<small>{file.unavailableReason}</small></div>
        : file.isBinary ? <BinaryReviewPanel file={file} />
        : typeof file.original === "string" && typeof file.modified === "string" ? <ReviewCanvas key={file.path} file={file} theme={theme} onSelection={setSelection} />
        : <div className="run-review-error">{t("review.evidenceUnavailable")}</div>}
      {file.rollbackState !== "applied" && <p className="run-review-notice">{t("review.historicalHint")}</p>}
      {!readOnly && onComment && !file.isBinary && <div className="run-review-comment">
        {!commentOpen ? <button type="button" disabled={!policy?.comment} onClick={() => { setCommentOpen(true); setCommentRevision(file.revision); setCommentSent(false); }}><MessageSquare size={13} />{t("review.addComment")}</button>
          : <form onSubmit={(event) => { event.preventDefault(); submitComment(); }}>
            <div className="run-review-comment-range">
              <label>{t("review.side")}<select value={selection.side} onChange={(event) => setSelection((current) => ({ ...current, side: event.target.value as LineSelection["side"] }))}><option value="modified">{t("review.modified")}</option><option value="original">{t("review.original")}</option></select></label>
              <label>{t("review.startLine")}<input type="number" min={1} value={selection.startLine} onChange={(event) => setSelection((current) => ({ ...current, startLine: Number(event.target.value) }))} /></label>
              <label>{t("review.endLine")}<input type="number" min={selection.startLine} value={selection.endLine} onChange={(event) => setSelection((current) => ({ ...current, endLine: Number(event.target.value) }))} /></label>
            </div>
            <label>{t("review.commentLabel")}<textarea rows={3} maxLength={8000} value={comment} onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submitComment(); } }} /></label>
            {commentRevision !== file.revision && <p role="alert">{t("review.commentStale")}</p>}
            <div className="run-review-actions"><button type="submit" disabled={!policy?.comment || commentRevision !== file.revision || !validReviewComment(file, { path: file.path, revision: file.revision, text: comment, ...selection })}>{t("review.sendComment")}</button><button type="button" onClick={() => setCommentOpen(false)}>{t("review.cancel")}</button></div>
          </form>}
        {commentSent && <p role="status">{t("review.commentSent")}</p>}
      </div>}
      {!!file.hunks.length && !file.isBinary && <details className="run-review-hunks">
        <summary><ChevronDown size={13} />{t("review.hunks", { count: file.hunks.length })}</summary>
        <p className="run-review-description">{t("review.hunkHint")}</p>
        {file.hunks.map((hunk, index) => <section key={`${hunk.mutationId}:${hunk.id}`} className="run-review-hunk">
          <header><strong>{t("review.hunkNumber", { count: index + 1 })}</strong><span className={`run-review-state ${reviewStatus(file, hunk)}`}>{t(`review.state.${reviewStatus(file, hunk)}`)}</span></header>
          <div className="run-review-hunk-code"><pre className="removed" aria-label={t("review.original")}>{hunk.preimage}</pre><pre className="added" aria-label={t("review.modified")}>{hunk.postimage}</pre></div>
          {hunk.truncated && <small>{t("review.hunkTruncated")}</small>}
          {hunkButtons(hunk)}
        </section>)}
      </details>}
    </article>}
    {!file && review.detailLoading && <div className="run-review-notice">{t("review.loading")}</div>}
  </section>;
}
