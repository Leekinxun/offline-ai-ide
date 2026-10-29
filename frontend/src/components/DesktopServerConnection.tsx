import React, { useState } from "react";
import { Server } from "lucide-react";
import { getDesktopBridge } from "../desktop/bridge";
import { useI18n } from "../i18n";
import "./DesktopServerConnection.css";

export const DesktopServerConnection: React.FC = () => {
  const { t } = useI18n();
  const desktop = getDesktopBridge();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  if (desktop?.connectionMode !== "remote") return null;

  const openSettings = async () => {
    if (!desktop.openConnectionSettings || opening) return;
    setOpening(true);
    setFailed(false);
    try { await desktop.openConnectionSettings(); }
    catch { setFailed(true); }
    finally { setOpening(false); }
  };

  return (
    <section className="desktop-server-connection" aria-label={t("desktop.server")}>
      <div className="desktop-server-heading"><Server size={16} aria-hidden="true" /><strong>{t("desktop.server")}</strong></div>
      <code title={desktop.serverUrl}>{desktop.serverUrl || window.location.origin}</code>
      <p>{t("desktop.serverDescription")}</p>
      {desktop.openConnectionSettings && <button type="button" className="dialog-btn" disabled={opening} onClick={() => void openSettings()}>{t("desktop.changeServer")}</button>}
      {failed && <p role="alert">{t("desktop.settingsFailed")}</p>}
    </section>
  );
};
