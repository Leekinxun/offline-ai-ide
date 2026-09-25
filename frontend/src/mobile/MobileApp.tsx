import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  Folder,
  Grid2X2,
  Inbox,
  Loader2,
  LogOut,
  MessageSquare,
  RefreshCcw,
  Send,
  ShieldCheck,
  Smartphone,
  Square,
  UserRound,
  X,
} from "lucide-react";
import { useModalDialogFocus } from "../components/useModalDialogFocus";
import {
  formatEventTime,
  formatWhen,
  MobileApiError,
  mobileApi,
  type MobileApproval,
  type MobileCommand,
  type MobileScope,
  type MobileSession,
  type MobileSnapshot,
  type MobileTask,
  type MobileTaskDetail,
} from "./api";
import "./MobileApp.css";

type Screen =
  | "home"
  | "tasks"
  | "new-task"
  | "task"
  | "approvals"
  | "approval"
  | "connections";
type DetailTab = "chat" | "process" | "changes";

const pairPath = "/mobile/pair";

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    running: "运行中",
    waiting: "等待中",
    pending: "待处理",
    completed: "已完成",
    complete: "已完成",
    done: "已完成",
    failed: "失败",
    stopped: "已停止",
    stopping: "正在停止",
    idle: "待继续",
    awaiting_approval: "等待审批",
    waiting_approval: "等待审批",
    approved: "已批准",
    denied: "已拒绝",
  };
  return labels[status] || status;
}

function statusTone(status: string): string {
  if (status === "running") return "running";
  if (/wait|pending|approval/i.test(status)) return "waiting";
  if (/fail|stop|denied/i.test(status)) return "danger";
  return "neutral";
}

function roleLabel(role: string): string {
  return (
    (
      {
        personal: "个人",
        owner: "所有者",
        admin: "管理员",
        member: "成员",
        viewer: "只读成员",
      } as Record<string, string>
    )[role] || role
  );
}

function riskLabel(risk: string): string {
  return (
    ({ low: "低", medium: "需确认", high: "高风险" } as Record<string, string>)[
      risk
    ] || risk
  );
}

function PairingScreen({
  onPaired,
}: {
  onPaired: (session: MobileSession) => void;
}) {
  const [ticket] = useState(() => {
    return new URLSearchParams(window.location.hash.slice(1)).get("ticket");
  });
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [shortCode, setShortCode] = useState("");
  const [phase, setPhase] = useState<
    "claiming" | "waiting" | "rejected" | "expired" | "error"
  >("claiming");
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const claimStarted = useRef(false);
  const exchanging = useRef(false);

  const claim = useCallback(async () => {
    if (!ticket || claimStarted.current) return;
    claimStarted.current = true;
    setPhase("claiming");
    setError(null);
    try {
      const result = await mobileApi.claimPairing(ticket);
      setClaimToken(result.claimToken);
      setShortCode(result.shortCode);
      setExpiresAt(result.expiresAt || null);
      setPhase("waiting");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法认领二维码。");
      setPhase(
        reason instanceof MobileApiError && reason.status === 410
          ? "expired"
          : "error",
      );
    }
  }, [ticket]);

  useEffect(() => {
    // The one-time ticket stays in memory after claim and never appears in browser history.
    if (ticket) window.history.replaceState({}, "", pairPath);
    if (!ticket) {
      setError("连接链接缺少配对票据，请重新扫描网页上的二维码。");
      setPhase("error");
      return;
    }
    void claim();
  }, [claim, ticket]);

  useEffect(() => {
    if (phase !== "waiting" || !claimToken) return;
    let active = true;
    const check = async () => {
      if (!active || exchanging.current) return;
      try {
        const result = await mobileApi.getClaimStatus(claimToken);
        if (!active) return;
        setExpiresAt(result.expiresAt || null);
        if (result.shortCode) setShortCode(result.shortCode);
        if (result.status === "approved") {
          exchanging.current = true;
          try {
            const response = await mobileApi.exchangeClaim(claimToken);
            if (active) {
              window.history.replaceState({}, "", "/mobile");
              onPaired(response.session);
            }
          } catch (reason) {
            exchanging.current = false;
            if (active)
              setError(
                reason instanceof Error
                  ? reason.message
                  : "连接确认失败，正在重试。",
              );
          }
        } else if (result.status === "rejected") setPhase("rejected");
        else if (result.status === "expired" || result.status === "used")
          setPhase("expired");
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "状态更新失败，正在重试。",
          );
      }
    };
    void check();
    const interval = window.setInterval(() => void check(), 2000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [claimToken, onPaired, phase]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const remaining = expiresAt
    ? Math.max(0, Math.ceil((expiresAt - now) / 1000))
    : null;
  const terminal =
    phase === "rejected" || phase === "expired" || phase === "error";

  return (
    <div className="cfm-shell cfm-pair-shell">
      <main className="cfm-pair-content">
        <img className="cfm-pair-logo" src="/favicon.svg" alt="CrownForge" />
        <p className="cfm-kicker">SECURE PAIRING</p>
        <h1>
          {phase === "claiming"
            ? "正在连接手机"
            : phase === "waiting"
              ? "等待网页端确认"
              : phase === "rejected"
                ? "连接已被拒绝"
                : phase === "expired"
                  ? "二维码已失效"
                  : "无法连接"}
        </h1>
        <p className="cfm-pair-lead">
          {terminal
            ? "请回到已登录的网页，重新生成二维码后用微信扫描。"
            : "请在网页端核对下方短码，再点击「允许这台手机」。确认前，手机无法查看工作区内容。"}
        </p>
        {phase === "waiting" && (
          <>
            <div className="cfm-pair-code-box">
              <small>在网页和手机上核对同一短码</small>
              <strong>{shortCode}</strong>
              <p>短码仅用于核对本次连接，不是登录密码。</p>
            </div>
            <div className="cfm-pair-target">
              <strong>将连接到 CrownForge 工作台</strong>
              <small>账号和工作区信息将在网页确认后显示</small>
            </div>
            <ul className="cfm-pair-permissions">
              <li>查看授权范围内的任务与运行状态</li>
              <li>按当前账号权限提交指令与处理待办</li>
              <li>可在网页端随时撤销本次连接</li>
            </ul>
          </>
        )}
        {phase === "claiming" && (
          <div className="cfm-pair-progress">
            <Loader2 className="cfm-spin" size={25} />
            正在认领一次性连接票据…
          </div>
        )}
        {error && (
          <p className="cfm-alert" role="alert">
            {error}
          </p>
        )}
        <div className="cfm-pair-bottom">
          <span>
            {phase === "waiting" && remaining !== null
              ? `票据将在 ${remaining} 秒后失效`
              : "连接由网页端确认"}
          </span>
          <button
            type="button"
            onClick={() => {
              window.location.href = "/mobile";
            }}
          >
            取消连接
          </button>
        </div>
      </main>
    </div>
  );
}

function UnconnectedScreen({
  expired,
  error,
  onRetry,
}: {
  expired: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="cfm-shell cfm-pair-shell">
      <main className="cfm-pair-content">
        <img className="cfm-pair-logo" src="/favicon.svg" alt="CrownForge" />
        <p className="cfm-kicker">MOBILE CONSOLE</p>
        <h1>
          {error
            ? "暂时无法连接"
            : expired
              ? "手机连接已结束"
              : "连接手机控制台"}
        </h1>
        <p className="cfm-pair-lead">
          {error
            ? "无法检查手机会话，请确认网络后重试。"
            : expired
              ? "此连接已过期或被网页端撤销。"
              : "请先在已登录的网页端打开「手机控制台」，生成二维码并用微信扫描。"}
        </p>
        {error && (
          <>
            <p className="cfm-alert" role="alert">
              {error}
            </p>
            <button className="cfm-retry" type="button" onClick={onRetry}>
              <RefreshCcw size={15} />
              重试连接
            </button>
          </>
        )}
        <div className="cfm-pair-target">
          <strong>需要网页端批准</strong>
          <small>扫码后，两端会显示相同短码供你核对。</small>
        </div>
      </main>
    </div>
  );
}

export function MobileApp() {
  const [pairingRoute, setPairingRoute] = useState(
    window.location.pathname === pairPath,
  );
  const [session, setSession] = useState<MobileSession | null>(null);
  const [checking, setChecking] = useState(!pairingRoute);
  const [expired, setExpired] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const onPaired = useCallback((connected: MobileSession) => {
    setSession(connected);
    setPairingRoute(false);
    setExpired(false);
  }, []);
  const onExpired = useCallback(() => {
    setSession(null);
    setExpired(true);
  }, []);

  useEffect(() => {
    if (pairingRoute) return;
    let active = true;
    mobileApi
      .getMe()
      .then(({ session: current }) => {
        if (active) {
          setSession(current);
          setConnectionError(null);
        }
      })
      .catch((reason) => {
        if (
          active &&
          !(reason instanceof MobileApiError && reason.status === 401)
        )
          setConnectionError(
            reason instanceof Error ? reason.message : "网络不可用",
          );
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [pairingRoute, retryKey]);

  if (pairingRoute) return <PairingScreen onPaired={onPaired} />;
  if (checking)
    return (
      <div className="cfm-shell cfm-loading">
        <Loader2 className="cfm-spin" size={26} />
        <span>正在验证手机连接…</span>
      </div>
    );
  if (!session)
    return (
      <UnconnectedScreen
        expired={expired}
        error={connectionError}
        onRetry={() => {
          setChecking(true);
          setConnectionError(null);
          setRetryKey((key) => key + 1);
        }}
      />
    );
  return (
    <MobileDashboard
      session={session}
      onSession={setSession}
      onExpired={onExpired}
    />
  );
}

function MobileDashboard({
  session,
  onSession,
  onExpired,
}: {
  session: MobileSession;
  onSession: (session: MobileSession) => void;
  onExpired: () => void;
}) {
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [detail, setDetail] = useState<MobileTaskDetail | null>(null);
  const [scopes, setScopes] = useState<MobileScope[]>([]);
  const [screen, setScreen] = useState<Screen>("home");
  const [taskId, setTaskId] = useState<string | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("chat");
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeDialogRef = useModalDialogFocus<HTMLElement>({
    open: scopeOpen,
    onClose: () => setScopeOpen(false),
  });
  const [message, setMessage] = useState("");
  const [newTaskMessage, setNewTaskMessage] = useState("");
  const [newTaskMode, setNewTaskMode] = useState<
    "ask" | "plan" | "code" | "review"
  >("code");
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scopeNonce, setScopeNonce] = useState(0);
  const refreshIndex = useRef(0);

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        const next = await mobileApi.getTask(id);
        if (taskIdRef.current === id) setDetail(next);
      } catch (reason) {
        if (
          reason instanceof MobileApiError &&
          (reason.status === 401 || reason.status === 403)
        )
          onExpired();
        else if (reason instanceof MobileApiError && reason.status === 404) {
          setDetail(null);
          setTaskId(null);
          taskIdRef.current = null;
          setScreen("tasks");
        } else
          setError(
            reason instanceof Error ? reason.message : "无法读取任务详情。",
          );
      }
    },
    [onExpired],
  );

  const refresh = useCallback(async () => {
    const index = ++refreshIndex.current;
    try {
      const next = await mobileApi.getSnapshot();
      if (index !== refreshIndex.current) return;
      setSnapshot(next);
      setError(null);
      if (taskIdRef.current) void loadDetail(taskIdRef.current);
    } catch (reason) {
      if (
        reason instanceof MobileApiError &&
        (reason.status === 401 || reason.status === 403)
      )
        onExpired();
      else
        setError(
          reason instanceof Error ? reason.message : "无法同步工作区状态。",
        );
    } finally {
      if (index === refreshIndex.current) setLoading(false);
    }
  }, [loadDetail, onExpired]);

  useEffect(() => {
    void refresh();
  }, [refresh, scopeNonce]);
  useEffect(() => {
    let active = true;
    mobileApi
      .getScopes()
      .then((result) => {
        if (active) setScopes(result.scopes);
      })
      .catch((reason) => {
        if (active && reason instanceof MobileApiError && reason.status === 401)
          onExpired();
      });
    return () => {
      active = false;
    };
  }, [onExpired, scopeNonce]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: number | null = null;
    let retry = 0;
    function connect() {
      if (disposed) return;
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${scheme}//${window.location.host}/ws/mobile`);
      socket.onopen = () => {
        retry = 0;
        setOnline(true);
        void refresh();
      };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as { type?: string };
          if (data.type === "invalidate" || data.type === "resync")
            void refresh();
        } catch {
          /* An unknown event cannot change the displayed state. */
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setOnline(false);
        // A server-side revocation can reject the WebSocket handshake before
        // it ever opens. The HTTP check distinguishes expiry from an outage.
        void refresh();
        const delay = Math.min(15_000, 1000 * 2 ** Math.min(retry++, 4));
        timer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    }
    connect();
    const foreground = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("focus", foreground);
    return () => {
      disposed = true;
      setOnline(false);
      if (timer !== null) window.clearTimeout(timer);
      socket?.close();
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("focus", foreground);
    };
  }, [refresh, scopeNonce, session.id]);

  useEffect(() => {
    const timestamp = session.expiresAt;
    if (!Number.isFinite(timestamp)) return;
    if (timestamp <= Date.now()) {
      onExpired();
      return;
    }
    const timer = window.setTimeout(onExpired, timestamp - Date.now());
    return () => window.clearTimeout(timer);
  }, [onExpired, session.expiresAt]);

  function openTask(id: string) {
    taskIdRef.current = id;
    setTaskId(id);
    setDetail(null);
    setDetailTab("chat");
    setScreen("task");
    void loadDetail(id);
  }

  async function switchScope(key: string) {
    if (key === session.scopeKey) {
      setScopeOpen(false);
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await mobileApi.switchScope(key, session.csrfToken);
      onSession(result.session);
      taskIdRef.current = null;
      setTaskId(null);
      setDetail(null);
      setSnapshot(null);
      setScreen("home");
      setScopeOpen(false);
      setLoading(true);
      setScopeNonce((value) => value + 1);
    } catch (reason) {
      if (reason instanceof MobileApiError && reason.status === 401)
        onExpired();
      else
        setError(reason instanceof Error ? reason.message : "无法切换工作区。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function command(
    action: Exclude<MobileCommand["action"], "start">,
    options: {
      taskId: string;
      runId: string;
      approvalId?: string;
      message?: string;
    },
  ) {
    if (!online || busyRef.current || !snapshot?.workspace.canWrite) return;
    const active = snapshot.activeRuns.find(
      (run) => run.runId === options.runId,
    );
    const task = snapshot.tasks.find((entry) => entry.id === options.taskId);
    const expectedVersion =
      active?.sequence ??
      (detail?.activeRun?.runId === options.runId
        ? detail.activeRun.sequence
        : task?.version);
    if (expectedVersion === undefined) {
      setError("任务状态尚未同步，请刷新后重试。");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await mobileApi.sendCommand(
        {
          commandId: crypto.randomUUID(),
          action,
          taskId: options.taskId,
          runId: options.runId,
          approvalId: options.approvalId,
          message: options.message,
          expectedVersion,
        },
        session.csrfToken,
      );
      if (!result.ok) throw new Error("服务端未接受操作。");
      setNotice(
        action === "steer"
          ? "指令已提交。"
          : action === "stop"
            ? "停止请求已提交。"
            : "审批结果已提交。",
      );
      if (action === "steer") setMessage("");
      await refresh();
    } catch (reason) {
      if (reason instanceof MobileApiError && reason.status === 401)
        onExpired();
      else {
        setError(
          reason instanceof Error ? reason.message : "提交失败，请刷新后重试。",
        );
        if (reason instanceof MobileApiError && reason.status === 409)
          void refresh();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function startTask(content: string, existing?: MobileTask) {
    const text = content.trim();
    if (
      !online ||
      busyRef.current ||
      !snapshot?.workspace.canWrite ||
      !text ||
      text.length > 4000
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await mobileApi.sendCommand(
        {
          commandId: crypto.randomUUID(),
          action: "start",
          message: text,
          ...(existing
            ? { taskId: existing.id, expectedVersion: existing.version }
            : { mode: newTaskMode }),
        },
        session.csrfToken,
      );
      if (!result.ok || !result.conversationId)
        throw new Error("服务端未接受任务。");
      setMessage("");
      setNewTaskMessage("");
      setNotice(existing ? "任务已继续。" : "任务已创建。");
      await refresh();
      openTask(result.conversationId);
    } catch (reason) {
      if (reason instanceof MobileApiError && reason.status === 401)
        onExpired();
      else {
        setError(
          reason instanceof Error ? reason.message : "无法开始任务，请重试。",
        );
        if (reason instanceof MobileApiError && reason.status === 409)
          void refresh();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function logout() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await mobileApi.logout(session.csrfToken);
      onExpired();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "退出失败，请重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const workspace = snapshot?.workspace;
  const tasks = snapshot?.tasks || [];
  const approvals = snapshot?.approvals || [];
  const currentTask =
    tasks.find((entry) => entry.id === taskId) || detail?.task;
  const approval = approvals.find((entry) => entry.id === approvalId);
  const activeTask = tasks.find(
    (entry) =>
      entry.runStatus === "running" ||
      entry.runStatus === "waiting_approval" ||
      entry.status === "running",
  );
  const writable = Boolean(workspace?.canWrite && online);
  const activeRun = detail?.activeRun;
  const canControlRun =
    writable && !!activeRun?.canControl && /running|waiting/i.test(activeRun.status);

  return (
    <div className="cfm-shell">
      <header className="cfm-header">
        <div className="cfm-header-top">
          <img src="/favicon.svg" alt="" />
          <div>
            <strong>CrownForge</strong>
            <small>手机控制台</small>
          </div>
          <button
            type="button"
            className="cfm-avatar"
            onClick={() => setScreen("connections")}
            aria-label="我的连接"
          >
            {session.username.slice(0, 2).toUpperCase()}
          </button>
        </div>
        <button
          type="button"
          className="cfm-scope-button"
          onClick={() => setScopeOpen(true)}
          disabled={!snapshot}
        >
          <Folder size={18} />
          <span>
            <strong>{workspace?.name || "读取工作区中"}</strong>
            <small>
              {workspace
                ? `${roleLabel(workspace.role)}权限 · ${scopes.length || 1} 个可访问工作区`
                : "正在同步权限"}
            </small>
          </span>
          <ChevronDown size={16} />
        </button>
      </header>
      {!online && (
        <div className="cfm-banner" role="status">
          <CircleAlert size={16} />
          实时连接中断，正在重试。此时不能提交操作。
        </div>
      )}
      {workspace && !workspace.canWrite && (
        <div className="cfm-banner cfm-readonly" role="status">
          <ShieldCheck size={16} />
          当前工作区为只读权限。
        </div>
      )}
      {error && (
        <div className="cfm-error" role="alert">
          <CircleAlert size={16} />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              void refresh();
            }}
            aria-label="重试"
          >
            <RefreshCcw size={15} />
          </button>
        </div>
      )}
      {notice && (
        <div className="cfm-notice" role="status">
          <Check size={15} />
          {notice}
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="关闭提示"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <main className="cfm-main">
        {loading && !snapshot ? (
          <div className="cfm-main-loading">
            <Loader2 size={23} className="cfm-spin" />
            正在读取工作区…
          </div>
        ) : null}
        {screen === "home" && snapshot && (
          <section className="cfm-screen">
            <div className="cfm-screen-heading">
              <div>
                <p>当前工作区</p>
                <h1>工作台</h1>
              </div>
              <span className={`cfm-sync ${online ? "" : "offline"}`}>
                <i />
                {online ? "实时同步" : "离线"}
              </span>
            </div>
            {approvals.length > 0 && (
              <div className="cfm-attention">
                <div>
                  <span>需要你处理</span>
                  <small>{approvals.length} 项待确认</small>
                </div>
                <h2>{approvals[0].title}</h2>
                <p>{approvals[0].summary}</p>
                <button
                  type="button"
                  onClick={() => {
                    setApprovalId(approvals[0].id);
                    setScreen("approval");
                  }}
                >
                  审查操作 <ChevronRight size={15} />
                </button>
              </div>
            )}
            <div className="cfm-section-title">
              <h2>正在进行</h2>
              <button type="button" onClick={() => setScreen("tasks")}>
                全部任务
              </button>
            </div>
            {activeTask ? (
              <article className="cfm-task-hero">
                <div className="cfm-task-top">
                  <span>{workspace?.name}</span>
                  <Status status={activeTask.runStatus || activeTask.status} />
                </div>
                <h2>{activeTask.title}</h2>
                <p>{activeTask.preview || "正在处理任务"}</p>
                <div className="cfm-task-foot">
                  <span>更新于 {formatEventTime(activeTask.updatedAt)}</span>
                  <button type="button" onClick={() => openTask(activeTask.id)}>
                    打开任务
                  </button>
                </div>
              </article>
            ) : (
              <Empty
                icon={<Clock3 size={24} />}
                title="这里暂时没有运行中的任务"
                body="最近任务会显示在下方。"
              />
            )}
            <div className="cfm-section-title">
              <h2>最近任务</h2>
              <span>按最近更新</span>
            </div>
            <TaskList tasks={tasks.slice(0, 5)} openTask={openTask} />
          </section>
        )}
        {screen === "tasks" && snapshot && (
          <section className="cfm-screen">
            <div className="cfm-screen-heading">
              <div>
                <p>{workspace?.name}</p>
                <h1>任务</h1>
              </div>
              <span className="cfm-count">{tasks.length} 个任务</span>
            </div>
            <button
              type="button"
              className="cfm-new-task-button"
              disabled={!writable}
              onClick={() => setScreen("new-task")}
            >
              <MessageSquare size={16} />
              新建任务
            </button>
            <TaskList tasks={tasks} openTask={openTask} />
          </section>
        )}
        {screen === "new-task" && (
          <section className="cfm-screen">
            <button
              type="button"
              className="cfm-back"
              onClick={() => setScreen("tasks")}
            >
              <ArrowLeft size={16} />
              全部任务
            </button>
            <p className="cfm-eyebrow">{workspace?.name}</p>
            <h1 className="cfm-detail-title">新建任务</h1>
            <p className="cfm-muted">
              描述你希望 CrownForge 完成的工作。任务将在当前工作区启动。
            </p>
            <div className="cfm-mode-list" aria-label="任务模式">
              {(["code", "ask", "plan", "review"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={newTaskMode === mode}
                  className={newTaskMode === mode ? "active" : ""}
                  onClick={() => setNewTaskMode(mode)}
                >
                  {
                    { code: "代码", ask: "问答", plan: "规划", review: "审查" }[
                      mode
                    ]
                  }
                </button>
              ))}
            </div>
            <textarea
              className="cfm-new-task-input"
              aria-label="任务内容"
              placeholder="输入任务目标和必要背景…"
              value={newTaskMessage}
              maxLength={4000}
              onChange={(event) => setNewTaskMessage(event.target.value)}
              disabled={!writable || busy}
            />
            <div className="cfm-new-task-foot">
              <span>{newTaskMessage.length} / 4000</span>
              <button
                type="button"
                disabled={!writable || !newTaskMessage.trim() || busy}
                onClick={() => void startTask(newTaskMessage)}
              >
                <Send size={16} />
                开始任务
              </button>
            </div>
          </section>
        )}
        {screen === "task" && (
          <section className="cfm-screen cfm-task-screen">
            <button
              type="button"
              className="cfm-back"
              onClick={() => setScreen("tasks")}
            >
              <ArrowLeft size={16} />
              全部任务
            </button>
            {currentTask ? (
              <>
                <h1 className="cfm-detail-title">{currentTask.title}</h1>
                <div className="cfm-detail-sub">
                  <Status
                    status={currentTask.runStatus || currentTask.status}
                  />
                  <span>{workspace?.name}</span>
                  <span>· {formatEventTime(currentTask.updatedAt)}</span>
                </div>
                <div className="cfm-tabs" role="tablist" aria-label="任务详情">
                  {(["chat", "process", "changes"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={detailTab === tab}
                      className={detailTab === tab ? "active" : ""}
                      onClick={() => setDetailTab(tab)}
                    >
                      {tab === "chat"
                        ? "对话"
                        : tab === "process"
                          ? "过程"
                          : "变更"}
                    </button>
                  ))}
                </div>
                {!detail && (
                  <div className="cfm-main-loading">
                    <Loader2 size={20} className="cfm-spin" />
                    正在读取任务详情…
                  </div>
                )}
                {detail && detailTab === "chat" && (
                  <div className="cfm-chat-panel">
                    {detail.messages.length === 0 ? (
                      <Empty
                        icon={<MessageSquare size={24} />}
                        title="暂无对话"
                        body="当前任务还没有可显示的对话内容。"
                      />
                    ) : (
                      detail.messages.map((entry, index) => (
                        <div
                          key={`${entry.timestamp}-${index}`}
                          className={`cfm-message ${entry.role === "user" ? "mine" : ""}`}
                        >
                          <div>
                            {entry.role === "user" ? "你" : "CrownForge"} ·{" "}
                            {formatEventTime(entry.timestamp)}
                          </div>
                          <p>{entry.content}</p>
                        </div>
                      ))
                    )}
                    {activeRun && (
                      <button
                        type="button"
                        className="cfm-tool-summary"
                        onClick={() => setDetailTab("process")}
                      >
                        查看运行过程 <ChevronRight size={15} />
                      </button>
                    )}
                    <div className="cfm-composer">
                      <textarea
                        aria-label={activeRun ? "补充指令" : "继续任务"}
                        placeholder={
                          !writable
                            ? "当前无法提交指令"
                            : activeRun
                              ? "补充指令或询问进度…"
                              : "继续这项任务…"
                        }
                        value={message}
                        maxLength={4000}
                        onChange={(event) => setMessage(event.target.value)}
                        disabled={
                          !(activeRun ? canControlRun : writable) || busy
                        }
                        rows={1}
                      />
                      <button
                        type="button"
                        aria-label={activeRun ? "发送指令" : "继续任务"}
                        disabled={
                          !(activeRun ? canControlRun : writable) ||
                          !message.trim() ||
                          busy
                        }
                        onClick={() => {
                          if (activeRun)
                            void command("steer", {
                              taskId: currentTask.id,
                              runId: activeRun.runId,
                              message: message.trim(),
                            });
                          else void startTask(message, currentTask);
                        }}
                      >
                        <Send size={17} />
                      </button>
                    </div>
                  </div>
                )}
                {detail && detailTab === "process" && (
                  <>
                    <div className="cfm-hint">
                      <CircleAlert size={16} />
                      {activeRun
                        ? `当前运行：${statusLabel(activeRun.status)}。新事件会实时同步。`
                        : "当前没有运行中的任务。"}
                    </div>
                    <div className="cfm-timeline">
                      {detail.runs.flatMap((run) => run.events).length === 0 ? (
                        <Empty
                          icon={<Clock3 size={23} />}
                          title="暂无过程事件"
                          body="任务运行后会在这里显示进度。"
                        />
                      ) : (
                        detail.runs
                          .flatMap((run) => run.events)
                          .sort((a, b) => b.timestamp - a.timestamp)
                          .map((event) => (
                            <div
                              key={event.id}
                              className={`cfm-event ${event.isError ? "error" : ""}`}
                            >
                              <strong>{event.label}</strong>
                              <small>
                                {formatEventTime(event.timestamp)} ·{" "}
                                {event.kind}
                              </small>
                            </div>
                          ))
                      )}
                    </div>
                    {activeRun && (
                      <button
                        type="button"
                        className="cfm-stop"
                        disabled={!canControlRun || busy}
                        onClick={() =>
                          void command("stop", {
                            taskId: currentTask.id,
                            runId: activeRun.runId,
                          })
                        }
                      >
                        <Square size={15} />
                        请求停止任务
                      </button>
                    )}
                  </>
                )}
                {detail && detailTab === "changes" && (
                  <>
                    <div className="cfm-metric">
                      <strong>{detail.changes.length}</strong>
                      <small>变更文件</small>
                    </div>
                    {detail.changes.length === 0 ? (
                      <Empty
                        icon={<FileText size={24} />}
                        title="暂无文件变更"
                        body="任务产生的文件变更会显示在这里。"
                      />
                    ) : (
                      <div className="cfm-list">
                        {detail.changes.map((change) => (
                          <div key={change.path} className="cfm-file-row">
                            <FileText size={16} />
                            <span>{change.path}</span>
                            <small>
                              {change.operation === "modified"
                                ? "已修改"
                                : change.operation === "added"
                                  ? "新增"
                                  : change.operation === "deleted"
                                    ? "删除"
                                    : change.operation || "已修改"}
                            </small>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="cfm-muted">
                      仅展示文件变更摘要，文件内容请在网页工作台查看。
                    </p>
                  </>
                )}
              </>
            ) : (
              <Empty
                icon={<FileText size={24} />}
                title="找不到任务"
                body="它可能已被删除或当前工作区无权访问。"
              />
            )}
          </section>
        )}
        {screen === "approvals" && snapshot && (
          <section className="cfm-screen">
            <div className="cfm-screen-heading">
              <div>
                <p>需要你决定</p>
                <h1>待办</h1>
              </div>
              <span className="cfm-count">{approvals.length} 项待处理</span>
            </div>
            {approvals.length === 0 ? (
              <Empty
                icon={<Check size={24} />}
                title="没有待处理的请求"
                body="需要你决定的操作会集中出现在这里。"
              />
            ) : (
              approvals.map((item) => (
                <article className="cfm-approval-card" key={item.id}>
                  <div>
                    <ShieldCheck size={18} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{formatEventTime(item.createdAt)}</small>
                    </span>
                    <Status status="pending" />
                  </div>
                  <p>{item.summary}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setApprovalId(item.id);
                      setScreen("approval");
                    }}
                  >
                    查看请求详情
                  </button>
                </article>
              ))
            )}
            <div className="cfm-hint">
              <ShieldCheck size={16} />
              只展示当前账号有权查看的请求。审批结果由服务端再次核验。
            </div>
          </section>
        )}
        {screen === "approval" && (
          <section className="cfm-screen">
            <button
              type="button"
              className="cfm-back"
              onClick={() => setScreen("approvals")}
            >
              <ArrowLeft size={16} />
              返回待办
            </button>
            {approval ? (
              <>
                <p className="cfm-eyebrow">操作请求 · {approval.id}</p>
                <h1 className="cfm-detail-title">{approval.title}</h1>
                <div className="cfm-detail-sub">
                  <Status status="pending" />
                  <span>{formatEventTime(approval.createdAt)}</span>
                </div>
                <div className="cfm-detail-card">
                  <small>请求内容</small>
                  <p>{approval.summary}</p>
                </div>
                <div className="cfm-section-title">
                  <h2>权限说明</h2>
                </div>
                <div className="cfm-hint">
                  <ShieldCheck size={16} />
                  允许仅对这一次请求生效。高风险操作可能需要回到网页完成。
                </div>
                <div className="cfm-detail-card">
                  <div className="cfm-facts">
                    <div>
                      <small>风险级别</small>
                      <strong>{riskLabel(approval.risk)}</strong>
                    </div>
                    <div>
                      <small>所属任务</small>
                      <strong>
                        {tasks.find((task) => task.id === approval.taskId)
                          ?.title || approval.taskId}
                      </strong>
                    </div>
                  </div>
                </div>
                <div className="cfm-decision">
                  <button
                    type="button"
                    disabled={!writable || !approval.canDecide || busy}
                    onClick={() =>
                      void command("deny", {
                        taskId: approval.taskId,
                        runId: approval.runId,
                        approvalId: approval.id,
                      })
                    }
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    disabled={!writable || !approval.canDecide || busy}
                    onClick={() =>
                      void command("approve_once", {
                        taskId: approval.taskId,
                        runId: approval.runId,
                        approvalId: approval.id,
                      })
                    }
                  >
                    允许一次
                  </button>
                </div>
                {(!workspace?.canWrite || !approval.canDecide) && (
                  <p className="cfm-readonly-note">
                    当前权限不能处理这项审批。
                  </p>
                )}
              </>
            ) : (
              <Empty
                icon={<Inbox size={24} />}
                title="这项请求已不可用"
                body="它可能已在网页端处理，请返回待办查看最新状态。"
              />
            )}
          </section>
        )}
        {screen === "connections" && (
          <section className="cfm-screen">
            <div className="cfm-screen-heading">
              <div>
                <p>账号与安全</p>
                <h1>我的连接</h1>
              </div>
            </div>
            <div className="cfm-connection-card">
              <div className="cfm-connection-head">
                <span>
                  <Smartphone size={21} />
                </span>
                <div>
                  <strong>这台手机 · 浏览器</strong>
                  <small>已连接 · 会话有效</small>
                </div>
              </div>
              <div className="cfm-facts">
                <div>
                  <small>当前身份</small>
                  <strong>{session.username}</strong>
                </div>
                <div>
                  <small>当前权限</small>
                  <strong>{workspace ? roleLabel(workspace.role) : "—"}</strong>
                </div>
                <div>
                  <small>连接范围</small>
                  <strong>{scopes.length} 个工作区</strong>
                </div>
                <div>
                  <small>会话到期</small>
                  <strong>{formatWhen(session.expiresAt)}</strong>
                </div>
              </div>
            </div>
            <div className="cfm-hint">
              <ShieldCheck size={16} />
              手机权限随账号和团队角色更新。网页端可以随时撤销这台设备的访问。
            </div>
            <button
              type="button"
              className="cfm-logout"
              disabled={busy}
              onClick={() => void logout()}
            >
              <LogOut size={16} />
              退出这台手机
            </button>
          </section>
        )}
      </main>
      <nav className="cfm-nav" aria-label="主导航">
        <NavButton
          icon={<Grid2X2 size={18} />}
          label="总览"
          active={screen === "home"}
          onClick={() => setScreen("home")}
        />
        <NavButton
          icon={<Folder size={18} />}
          label="任务"
          active={
            screen === "tasks" || screen === "new-task" || screen === "task"
          }
          onClick={() => setScreen("tasks")}
        />
        <NavButton
          icon={<Bell size={18} />}
          label="待办"
          count={approvals.length}
          active={screen === "approvals" || screen === "approval"}
          onClick={() => setScreen("approvals")}
        />
        <NavButton
          icon={<UserRound size={18} />}
          label="我的"
          active={screen === "connections"}
          onClick={() => setScreen("connections")}
        />
      </nav>
      {scopeOpen && (
        <div
          className="cfm-sheet-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setScopeOpen(false);
          }}
        >
          <section
            ref={scopeDialogRef}
            tabIndex={-1}
            className="cfm-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cfm-scope-title"
          >
            <div className="cfm-sheet-handle" />
            <div className="cfm-sheet-heading">
              <h2 id="cfm-scope-title">切换工作区</h2>
              <button
                type="button"
                onClick={() => setScopeOpen(false)}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <p>手机只会看到当前选择的工作区。切换不会影响网页工作台。</p>
            <div className="cfm-scope-list">
              {scopes.map((scope) => (
                <button
                  type="button"
                  key={scope.key}
                  disabled={busy}
                  onClick={() => void switchScope(scope.key)}
                >
                  <Folder size={17} />
                  <span>
                    <strong>{scope.name}</strong>
                    <small>{roleLabel(scope.role)}权限</small>
                  </span>
                  {scope.key === session.scopeKey ? (
                    <Check size={17} />
                  ) : (
                    <ArrowRight size={17} />
                  )}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Status({ status }: { status: string }) {
  return (
    <span className={`cfm-status ${statusTone(status)}`}>
      <i />
      {statusLabel(status)}
    </span>
  );
}
function Empty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="cfm-empty">
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}
function TaskList({
  tasks,
  openTask,
}: {
  tasks: MobileTask[];
  openTask: (id: string) => void;
}) {
  if (tasks.length === 0)
    return (
      <Empty
        icon={<Folder size={24} />}
        title="暂无任务"
        body="当前工作区还没有可查看的任务。"
      />
    );
  return (
    <div className="cfm-list">
      {tasks.map((task) => (
        <button
          type="button"
          className="cfm-task-row"
          key={task.id}
          onClick={() => openTask(task.id)}
        >
          <span className="cfm-task-row-icon">
            <MessageSquare size={16} />
          </span>
          <span>
            <strong>{task.title}</strong>
            <small>
              {statusLabel(task.runStatus || task.status)} ·{" "}
              {formatEventTime(task.updatedAt)}
            </small>
          </span>
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  );
}
function NavButton({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "active" : ""}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      <span>{label}</span>
      {Boolean(count) && <em>{count}</em>}
    </button>
  );
}
