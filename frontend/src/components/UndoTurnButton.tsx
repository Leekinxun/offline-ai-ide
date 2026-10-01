import { useState } from "react";
import { Undo2 } from "lucide-react";
import { useI18n } from "../i18n";

export function UndoTurnButton({ onUndo, disabled }: { onUndo?: () => Promise<void>; disabled?: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!onUndo) return null;
  return <div className="undo-turn-control">
    <button type="button" className="dialog-btn" disabled={disabled || busy} onClick={() => {
      setBusy(true); setError(null);
      void onUndo().catch((reason) => setError(reason instanceof Error ? reason.message : t("undoTurn.failed"))).finally(() => setBusy(false));
    }} title={t("undoTurn.hint")}><Undo2 size={13} />{t(busy ? "common.loading" : "undoTurn.label")}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
