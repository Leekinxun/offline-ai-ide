import React from "react";
import { X } from "lucide-react";
import type { ReferenceLocation } from "../types";
import { useI18n } from "../i18n";

interface ReferencePanelProps {
  symbol: string;
  references: ReferenceLocation[];
  onNavigate: (path: string, selection: ReferenceLocation["selection"]) => void;
  onClose: () => void;
}

export const ReferencePanel: React.FC<ReferencePanelProps> = ({
  symbol,
  references,
  onNavigate,
  onClose,
}) => {
  const { t } = useI18n();
  return (
    <section className="editor-reference-panel" aria-label={t("editor.referencesTitle")}>
      <div className="editor-reference-header">
        <div className="editor-reference-heading">
          <strong>{t("editor.referencesTitle")}</strong>
          <span>{symbol} · {references.length}</span>
        </div>
        <button type="button" className="editor-reference-close" onClick={onClose} aria-label={t("editor.closeReferences")}>
          <X size={15} />
        </button>
      </div>
      {references.length === 0 ? (
        <div className="editor-reference-empty">{t("editor.noReferences")}</div>
      ) : (
        <div className="editor-reference-list">
          {references.map((reference, index) => (
            <button
              type="button"
              className="editor-reference-item"
              key={`${reference.path}:${reference.selection.startLine}:${reference.selection.startColumn}:${index}`}
              onClick={() => onNavigate(reference.path, reference.selection)}
            >
              <span className="editor-reference-path">{reference.path}</span>
              <span className="editor-reference-location">
                {reference.selection.startLine}:{reference.selection.startColumn}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
};
