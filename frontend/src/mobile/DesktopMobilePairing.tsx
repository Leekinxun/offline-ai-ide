import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as QRCode from "qrcode";
import {
  Check,
  Clipboard,
  Loader2,
  MonitorSmartphone,
  RefreshCcw,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { useModalDialogFocus } from "../components/useModalDialogFocus";
import {
  formatWhen,
  MobileApiError,
  mobileApi,
  type MobileDevice,
  type PairingTicket,
} from "./api";
import "./DesktopMobilePairing.css";

interface Props {
  token: string;
  onClose: () => void;
  onSessionExpired: () => void;
}

const terminalStatuses = new Set(["rejected", "expired", "used"]);

export function DesktopMobilePairing({ token, onClose, onSessionExpired }: Props) {
  const [pairing, setPairing] = useState<PairingTicket | null>(null);
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const activeRef = useRef(false);
  const expiredRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const dialogRef = useModalDialogFocus<HTMLElement>({
    open: true,
    onClose: () => void close(),
  });

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const handleError = useCallback((reason: unknown, fallback: string) => {
    if (!activeRef.current || expiredRef.current) return;
    if (reason instanceof MobileApiError && reason.status === 401) {
      expiredRef.current = true;
      onSessionExpired();
      return;
    }
    setError(reason instanceof Error ? reason.message : fallback);
  }, [onSessionExpired]);

  const refreshDevices = useCallback(async () => {
    try {
      const result = await mobileApi.listDevices(token);
      setDevices(result.devices);
    } catch (reason) {
      handleError(reason, "无法读取已连接设备。");
    }
  }, [handleError, token]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);
  useEffect(() => {
    if (pairing?.status === "used") void refreshDevices();
  }, [pairing?.status, refreshDevices]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!pairing?.id || terminalStatuses.has(pairing.status)) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await mobileApi.getPairing(token, pairing.id);
        if (active)
          setPairing((previous) =>
            previous?.id === next.id ? { ...previous, ...next } : previous,
          );
      } catch (reason) {
        if (active) handleError(reason, "无法更新配对状态。");
      }
    };
    const interval = window.setInterval(() => {
      void poll();
    }, 2000);
    void poll();
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [handleError, pairing?.id, pairing?.status, token]);

  const pairUrl = useMemo(() => pairing?.pairUrl || null, [pairing?.pairUrl]);

  useEffect(() => {
    if (!pairUrl || pairing?.status !== "pending") {
      setQrImage(null);
      return;
    }
    let active = true;
    QRCode.toDataURL(pairUrl, {
      width: 216,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#1b2430", light: "#ffffff" },
    })
      .then((image) => {
        if (active) setQrImage(image);
      })
      .catch(() => {
        if (active) setError("二维码生成失败，请复制连接链接。");
      });
    return () => {
      active = false;
    };
  }, [pairUrl, pairing?.status]);

  const secondsLeft = pairing
    ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000))
    : 0;
  const canApprove = pairing?.status === "claimed" && secondsLeft > 0;

  async function createPairing() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setPairing(await mobileApi.createPairing(token));
      setNow(Date.now());
    } catch (reason) {
      handleError(reason, "无法创建扫码连接。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function decide(approve: boolean) {
    if (!pairing || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = approve
        ? await mobileApi.approvePairing(token, pairing.id)
        : await mobileApi.rejectPairing(token, pairing.id);
      setPairing((previous) => (previous ? { ...previous, ...next } : next));
      setNotice(
        approve ? "已批准连接，等待手机完成接入。" : "已拒绝本次连接。",
      );
    } catch (reason) {
      handleError(reason, "操作失败，请刷新状态后重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await mobileApi.revokeDevice(token, id);
      setDevices((previous) => previous.filter((device) => device.id !== id));
      setNotice("设备已下线。");
    } catch (reason) {
      handleError(reason, "无法下线设备。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!pairUrl) return;
    try {
      await navigator.clipboard.writeText(pairUrl);
      setNotice("连接链接已复制。");
    } catch {
      setNotice("请选中下方链接手动复制。");
    }
  }

  async function close() {
    if (busyRef.current) return;
    if (
      pairing &&
      (pairing.status === "pending" || pairing.status === "claimed") &&
      secondsLeft > 0
    ) {
      try {
        await mobileApi.rejectPairing(token, pairing.id);
      } catch (reason) {
        handleError(reason, "无法取消本次配对，请重试。");
        return;
      }
    }
    onClose();
  }

  return (
    <div
      className="desktop-mobile-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void close();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="desktop-mobile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-mobile-title"
      >
        <header className="desktop-mobile-header">
          <div className="desktop-mobile-heading-icon">
            <MonitorSmartphone size={22} />
          </div>
          <div>
            <p>跨设备连接</p>
            <h2 id="desktop-mobile-title">手机控制台</h2>
          </div>
          <button
            type="button"
            className="desktop-mobile-icon-button"
            onClick={() => void close()}
            aria-label="关闭"
            disabled={busy}
          >
            <X size={18} />
          </button>
        </header>

        <div className="desktop-mobile-body">
          <p className="desktop-mobile-lead">
            用微信扫描二维码，在手机上查看工作区状态并按你的权限处理任务。手机认领后，请核对两端短码再允许连接。
          </p>
          {error && (
            <p className="desktop-mobile-alert error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="desktop-mobile-alert" role="status">
              {notice}
            </p>
          )}

          {!pairing ||
          terminalStatuses.has(pairing.status) ||
          secondsLeft === 0 ? (
            <div className="desktop-mobile-start">
              <Smartphone size={30} />
              <strong>
                {pairing?.status === "used"
                  ? "手机已连接"
                  : pairing?.status === "rejected"
                    ? "连接已拒绝"
                    : pairing
                      ? "二维码已失效"
                      : "连接一台手机"}
              </strong>
              <span>每个二维码只能使用一次，90 秒后自动失效。</span>
              <button
                type="button"
                className="desktop-mobile-primary"
                disabled={busy}
                onClick={() => void createPairing()}
              >
                {busy ? (
                  <Loader2 size={16} className="desktop-mobile-spin" />
                ) : (
                  <RefreshCcw size={16} />
                )}
                {pairing ? "生成新二维码" : "生成二维码"}
              </button>
            </div>
          ) : pairing.status === "approved" ? (
            <div className="desktop-mobile-claimed">
              <div className="desktop-mobile-device-icon">
                <Loader2 size={22} className="desktop-mobile-spin" />
              </div>
              <p>网页端已确认</p>
              <strong>等待手机完成连接</strong>
              <span>请保持手机页面打开。连接完成后会显示在下方设备列表。</span>
              <small>剩余 {secondsLeft} 秒</small>
            </div>
          ) : pairing.status === "claimed" ? (
            <div className="desktop-mobile-claimed">
              <div className="desktop-mobile-device-icon">
                <Smartphone size={22} />
              </div>
              <p>有手机请求连接</p>
              <strong>{pairing.deviceName || "手机浏览器"}</strong>
              <span>请在手机和网页上核对同一短码</span>
              <div
                className="desktop-mobile-code"
                aria-label={`连接短码 ${pairing.shortCode || "正在获取"}`}
              >
                {pairing.shortCode || "······"}
              </div>
              <small>剩余 {secondsLeft} 秒 · 确认前手机无法查看工作区</small>
              <div className="desktop-mobile-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(false)}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="desktop-mobile-primary"
                  disabled={busy || !canApprove}
                  onClick={() => void decide(true)}
                >
                  <Check size={16} />
                  允许这台手机
                </button>
              </div>
            </div>
          ) : (
            <div className="desktop-mobile-qr">
              <div className="desktop-mobile-qr-frame">
                {qrImage ? (
                  <img
                    src={qrImage}
                    width="216"
                    height="216"
                    alt="手机连接二维码"
                  />
                ) : (
                  <Loader2 size={24} className="desktop-mobile-spin" />
                )}
              </div>
              <strong>微信扫码，等待手机认领</strong>
              <span>二维码将在 {secondsLeft} 秒后失效</span>
              {pairUrl &&
                /(?:localhost|127\.0\.0\.1|\[::1\])/.test(
                  new URL(pairUrl).hostname,
                ) && (
                  <p className="desktop-mobile-localhost">
                    当前是本机地址，手机可能无法访问。请配置手机可达的 HTTPS
                    域名后重新生成。
                  </p>
                )}
              <button
                type="button"
                className="desktop-mobile-copy"
                onClick={() => void copyLink()}
              >
                <Clipboard size={15} />
                复制连接链接
              </button>
              <input
                aria-label="手机连接链接"
                readOnly
                value={pairUrl || ""}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                className="desktop-mobile-text-button"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                取消本次连接
              </button>
            </div>
          )}

          <div className="desktop-mobile-devices-heading">
            <h3>已连接设备</h3>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshDevices()}
              aria-label="刷新已连接设备"
            >
              <RefreshCcw size={15} />
            </button>
          </div>
          {devices.length === 0 ? (
            <p className="desktop-mobile-empty">暂无已连接的手机。</p>
          ) : (
            <ul className="desktop-mobile-device-list">
              {devices.map((device) => (
                <li key={device.id}>
                  <Smartphone size={18} />
                  <span>
                    <strong>{device.deviceName || "手机浏览器"}</strong>
                    <small>
                      最近活动 {formatWhen(device.lastSeenAt)} · 到期{" "}
                      {formatWhen(device.expiresAt)}
                    </small>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(device.id)}
                  >
                    下线
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="desktop-mobile-footnote">
            <ShieldCheck size={15} />
            手机权限由服务端按当前账号和工作区权限核验，可随时在这里撤销。
          </p>
        </div>
      </section>
    </div>
  );
}
