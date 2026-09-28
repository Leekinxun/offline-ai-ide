import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as monaco from "monaco-editor";
import { Check, ExternalLink, Undo2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { ReviewFile, ReviewHunk } from "./runReviewPolicy";
import { buildEditorReviewLayout, canApplyEditorReviewAction, type EditorReviewBlock, type EditorReviewSnapshot } from "../editor/editorChangeReviewPolicy";
import "./EditorChangeReview.css";

export interface EditorChangeReviewBindings {
  changeReviewFile?: ReviewFile | null;
  changeReviewRunning?: boolean;
  changeReviewBusy?: boolean;
  onChangeReviewAction?: (file: ReviewFile, hunk: ReviewHunk, decision: "keep" | "revert") => Promise<void> | void;
  onOpenChangeReview?: () => void;
}
interface EditorChangeReviewProps extends EditorChangeReviewBindings {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  path: string;
  dirty: boolean;
  readOnly: boolean;
}
interface ReviewZone {
  id: string;
  node: HTMLDivElement;
  block?: EditorReviewBlock;
  hunks: ReviewHunk[];
  snapshot: EditorReviewSnapshot;
  lineHeight: number;
  fontFamily: string;
  fontSize: number;
}

export const EditorChangeReview: React.FC<EditorChangeReviewProps> = (props) => {
  const { editor, path, dirty, changeReviewFile: file } = props;
  const { t } = useI18n();
  const [zones, setZones] = useState<ReviewZone[]>([]);
  const [modelEpoch, setModelEpoch] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const propsRef = useRef(props);
  const clearResourcesRef = useRef<(() => void) | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  propsRef.current = props;

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  useEffect(() => {
    if (!editor) return;
    const invalidate = () => {
      // Remove actionable DOM immediately, before React can render the dirty prop.
      clearResourcesRef.current?.();
      setZones([]);
      setModelEpoch((value) => value + 1);
    };
    const subscriptions = [editor.onDidChangeModelContent(invalidate), editor.onDidChangeModel(invalidate),
      editor.onDidChangeConfiguration((event) => {
        if (event.hasChanged(monaco.editor.EditorOption.lineHeight) || event.hasChanged(monaco.editor.EditorOption.fontInfo)) invalidate();
      })];
    return () => { for (const subscription of subscriptions) subscription.dispose(); };
  }, [editor]);

  useEffect(() => {
    setError(null);
    const model = editor?.getModel();
    if (!editor || !model || model.isDisposed() || !file) { setZones([]); return; }
    const layout = buildEditorReviewLayout(file, path, model.getValue(), dirty);
    if (!layout) { setZones([]); return; }
    const snapshot: EditorReviewSnapshot = { path, modelUri: model.uri.toString(), modelVersion: model.getVersionId(), content: model.getValue(), revision: file.revision };
    const font = editor.getOption(monaco.editor.EditorOption.fontInfo);
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const decorations = editor.createDecorationsCollection(layout.blocks.filter((block) => block.added.length).map((block) => ({
      range: new monaco.Range(block.modifiedStartLine, 1, Math.min(model.getLineCount(), block.modifiedStartLine + block.added.length - 1), 1),
      options: {
        isWholeLine: true,
        className: "editor-change-review-added-line",
        linesDecorationsClassName: "editor-change-review-added-gutter",
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        overviewRuler: { color: "#2da44e88", position: monaco.editor.OverviewRulerLane.Left },
      },
    })));
    const zoneIds: string[] = [];
    const rendered: ReviewZone[] = [];
    let disposed = false;
    let cleared = false;
    const disposeSubscription = editor.onDidDispose(() => { disposed = true; });
    const clear = () => {
      if (cleared) return;
      cleared = true;
      if (!disposed) {
        decorations.clear();
        editor.changeViewZones((accessor) => { for (const id of zoneIds) accessor.removeZone(id); });
      }
    };
    clearResourcesRef.current = clear;
    editor.changeViewZones((accessor) => {
      const addZone = (block?: EditorReviewBlock) => {
        const node = document.createElement("div");
        node.className = "editor-change-review-zone-host";
        const hunks = block ? layout.positionedHunks.filter((entry) => entry.blockId === block.id).map((entry) => entry.hunk) : [];
        const deletedLines = block?.removed.length || 0;
        const id = accessor.addZone({
          afterLineNumber: Math.min(model.getLineCount(), Math.max(0, (block?.modifiedStartLine || 1) - 1)),
          heightInPx: 34 + (deletedLines ? Math.min(deletedLines, 8) * lineHeight + 12 : 0) + (deletedLines > 8 ? 20 : 0),
          domNode: node,
          suppressMouseDown: false,
          showInHiddenAreas: true,
        });
        zoneIds.push(id);
        rendered.push({ id, node, block, hunks, snapshot, lineHeight, fontFamily: font.fontFamily, fontSize: font.fontSize });
      };
      if (layout.largeDiff || layout.unavailableHunks.length || (!layout.positionedHunks.length && !layout.blocks.length)) addZone();
      for (const block of layout.blocks) addZone(block);
    });
    setZones(rendered);
    return () => {
      clear(); disposeSubscription.dispose();
      if (clearResourcesRef.current === clear) clearResourcesRef.current = null;
    };
  }, [editor, path, dirty, file, modelEpoch]);

  const decide = async (zone: ReviewZone, hunk: ReviewHunk, decision: "keep" | "revert") => {
    const current = propsRef.current;
    const model = current.editor?.getModel();
    if (pendingRef.current || !model || model.isDisposed() || !current.onChangeReviewAction) return;
    const allowed = canApplyEditorReviewAction(zone.snapshot, {
      path: current.path, modelUri: model.uri.toString(), modelVersion: model.getVersionId(), content: model.getValue(),
      dirty: current.dirty, readOnly: current.readOnly || current.editor!.getOption(monaco.editor.EditorOption.readOnly),
    }, current.changeReviewFile, hunk, decision, { running: Boolean(current.changeReviewRunning), busy: Boolean(current.changeReviewBusy) });
    if (!allowed) {
      clearResourcesRef.current?.(); setZones([]); setError(t("editorReview.stale"));
      return;
    }
    pendingRef.current = true; setPendingId(`${hunk.mutationId}:${hunk.id}`); setError(null);
    try { await current.onChangeReviewAction(current.changeReviewFile!, hunk, decision); }
    catch (reason) { if (mountedRef.current) setError(reason instanceof Error ? reason.message : t("editorReview.failed")); }
    finally { pendingRef.current = false; if (mountedRef.current) setPendingId(null); }
  };

  return <>
    {zones.map((zone) => createPortal(
      <div className="editor-change-review-zone" role="group" aria-label={t("editorReview.title")}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); propsRef.current.editor?.focus(); } }}>
        <div className="editor-change-review-toolbar">
          <span>{zone.block ? t("editorReview.persisted", { added: zone.block.added.length, removed: zone.block.removed.length }) : t("editorReview.fullReviewRequired")}</span>
          <div className="editor-change-review-actions">
            {props.onChangeReviewAction && zone.hunks.map((hunk) => <React.Fragment key={`${hunk.mutationId}:${hunk.id}`}>
              <button type="button" disabled={props.readOnly || props.changeReviewBusy || pendingId !== null || hunk.kept || hunk.reverted}
                onClick={() => void decide(zone, hunk, "keep")}><Check size={12} />{t(hunk.kept ? "editorReview.kept" : "editorReview.keep")}</button>
              <button type="button" disabled={props.readOnly || props.changeReviewBusy || pendingId !== null || props.changeReviewRunning || hunk.reverted}
                title={props.changeReviewRunning ? t("editorReview.stopBeforeUndo") : t("editorReview.undo")}
                onClick={() => void decide(zone, hunk, "revert")}><Undo2 size={12} />{t("editorReview.undo")}</button>
            </React.Fragment>)}
            {props.onOpenChangeReview && <button type="button" onClick={() => propsRef.current.onOpenChangeReview?.()} title={t("editorReview.openFull")} aria-label={t("editorReview.openFull")}><ExternalLink size={12} /></button>}
          </div>
        </div>
        {!!zone.block?.removed.length && <pre className="editor-change-review-deleted" aria-label={t("editorReview.deleted")}
          style={{ fontFamily: zone.fontFamily, fontSize: zone.fontSize, lineHeight: `${zone.lineHeight}px`, maxHeight: zone.lineHeight * 8 }}>
          {zone.block.removed.join("")}
        </pre>}
        {(zone.block?.removed.length || 0) > 8 && <span className="editor-change-review-more">{t("editorReview.scrollDeleted")}</span>}
      </div>, zone.node, zone.id,
    ))}
    {error && <div className="editor-change-review-error" role="alert">{error}</div>}
  </>;
};
