import React, { useRef, useState } from "react";
import { CheckCircle2, Download, FileArchive, FileCheck2, LoaderCircle, ShieldAlert, Upload, XCircle } from "lucide-react";
import type { ChangeSet } from "../hooks/useCheckpoints";
import type { useOfflineBundles } from "../hooks/useOfflineBundles";
import { useI18n } from "../i18n";
import { changeSetReviewRevision, isCurrentChangeSet } from "../hooks/changeSetContract";

type OfflineBundleController = ReturnType<typeof useOfflineBundles>;

interface OfflineBundlePanelProps {
  controller: OfflineBundleController;
  changeSets: ChangeSet[];
  readOnly?: boolean;
}

export const OfflineBundlePanel: React.FC<OfflineBundlePanelProps> = ({ controller, changeSets, readOnly = false }) => {
  const { t } = useI18n();
  const [changeSetId, setChangeSetId] = useState(changeSets[0]?.id || "");
  const [includeTrace, setIncludeTrace] = useState(true);
  const [includeTestOutput, setIncludeTestOutput] = useState(true);
  const [signaturePolicy, setSignaturePolicy] = useState<"optional" | "required">("optional");
  const [localError, setLocalError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = changeSets.find((item) => item.id === changeSetId) || changeSets[0];
  const revision = selected ? changeSetReviewRevision(selected) || "" : "";
  const currentSelection = Boolean(selected && isCurrentChangeSet(selected));

  const invoke = async (action: () => Promise<unknown>) => {
    setLocalError(null);
    try { await action(); }
    catch (nextError) { setLocalError(nextError instanceof Error ? nextError.message : t("bundle.operationFailed")); }
  };

  return <section className="offline-bundle-panel" aria-labelledby="offline-bundle-title">
    <header><FileArchive size={16} /><div><strong id="offline-bundle-title">{t("bundle.title")}</strong><span>{t("bundle.hint")}</span></div></header>
    <div className="delivery-form">
      <label><span>{t("delivery.changeSet")}</span><select className="dialog-input" value={selected?.id || ""} onChange={(event) => setChangeSetId(event.target.value)}><option value="">{t("delivery.selectChangeSet")}</option>{changeSets.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 12)} · {item.patch.sha256.slice(0, 12)} · {t(`recovery.changeSetStatus.${item.status}`)}</option>)}</select></label>
      <label><span>{t("bundle.signaturePolicy")}</span><select className="dialog-input" value={signaturePolicy} onChange={(event) => setSignaturePolicy(event.target.value as "optional" | "required")}><option value="optional">{t("bundle.signatureOptional")}</option><option value="required">{t("bundle.signatureRequired")}</option></select></label>
      <label className="delivery-checkbox"><input type="checkbox" checked={includeTrace} onChange={(event) => setIncludeTrace(event.target.checked)} />{t("bundle.includeTrace")}</label>
      <label className="delivery-checkbox"><input type="checkbox" checked={includeTestOutput} onChange={(event) => setIncludeTestOutput(event.target.checked)} />{t("bundle.includeTestOutput")}</label>
    </div>
    {selected && <div className="bundle-revision-lock"><ShieldAlert size={14} /><span>{t("bundle.revisionLocked")} · {t(`recovery.changeSetStatus.${selected.status}`)}</span><code>{revision.slice(0, 12)}</code></div>}
    {selected && !currentSelection && <div className="delivery-notice" role="status">{t("recovery.legacyChangeSetReadOnly", { version: selected.schemaVersion })}</div>}
    <div className="offline-bundle-actions">
      <button type="button" className="dialog-btn" disabled={!currentSelection || controller.busyId !== null} onClick={() => void invoke(() => controller.exportReviewArtifact(selected!.id, revision, "crewforge"))}><Download size={13} />{t("bundle.exportCrewForge")}</button>
      <button type="button" className="dialog-btn" disabled={!currentSelection || controller.busyId !== null} onClick={() => void invoke(() => controller.exportReviewArtifact(selected!.id, revision, "sarif"))}><Download size={13} />SARIF</button>
      <button type="button" className="dialog-btn primary" disabled={!currentSelection || readOnly || controller.busyId !== null} title={readOnly ? t("delivery.readOnly") : undefined} onClick={() => void invoke(() => controller.createExport(selected!.id, revision, { includeTrace, includeTestOutput, requireSignature: signaturePolicy === "required" }))}><FileArchive size={13} />{t("bundle.build")}</button>
      <input ref={fileRef} className="visually-hidden" type="file" accept=".zip,.tar,.tgz,.crewforge,application/zip,application/gzip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void invoke(() => controller.verify(file)); event.currentTarget.value = ""; }} />
      <button type="button" className="dialog-btn" disabled={controller.busyId !== null} onClick={() => fileRef.current?.click()}><Upload size={13} />{t("bundle.verify")}</button>
    </div>
    {(controller.error || localError) && <div className="delivery-inline-error" role="alert">{localError || controller.error}</div>}
    {controller.exports.length > 0 && <div className="bundle-export-list" role="status" aria-live="polite" aria-atomic="true">{controller.exports.map((entry) => <article key={entry.exportId} className={`status-${entry.status}`}><span>{entry.status === "ready" ? <CheckCircle2 size={15} /> : entry.status === "failed" ? <XCircle size={15} /> : <LoaderCircle size={15} className="chat-spin" />}</span><div><strong>{t(`bundle.status.${entry.status}`)}</strong><code>{entry.revision.slice(0, 12)}{entry.manifestDigest ? ` · ${entry.manifestDigest.slice(0, 12)}` : ""}</code>{entry.phase && <small>{entry.phase}{typeof entry.progress === "number" ? ` · ${entry.progress}%` : ""}</small>}</div>{entry.status === "ready" && <button type="button" className="dialog-btn" onClick={() => void invoke(() => controller.download(entry))}><Download size={13} />{t("common.download")}</button>}</article>)}</div>}
    {controller.verification && <section className={`bundle-verification integrity-${controller.verification.integrity}`} aria-label={t("bundle.verificationResult")}>
      <header>{controller.verification.integrity === "verified" ? <FileCheck2 size={17} /> : <XCircle size={17} />}<strong>{t(`bundle.integrity.${controller.verification.integrity}`)}</strong>{controller.verification.manifestDigest && <code>{controller.verification.manifestDigest.slice(0, 16)}</code>}</header>
      <dl><div><dt>{t("bundle.authenticity")}</dt><dd>{t(`bundle.authenticity.${controller.verification.authenticity}`)}</dd></div><div><dt>{t("bundle.bindings")}</dt><dd>{t(`bundle.bindings.${controller.verification.bindings}`)}</dd></div><div><dt>{t("bundle.patchApplies")}</dt><dd>{controller.verification.applicability.patchApplies ? t("common.yes") : t("common.no")}</dd></div></dl>
      {controller.verification.authenticity === "unsigned" && <div className="delivery-notice">{t("bundle.unsignedHint")}</div>}
      {controller.verification.issues.length > 0 && <ul>{controller.verification.issues.map((issue, index) => <li key={`${issue.code || index}:${issue.path || ""}`}>{issue.path && <code>{issue.path}</code>}{issue.message}</li>)}</ul>}
    </section>}
  </section>;
};
