import React, { useState, useCallback, useRef, useEffect } from "react";
import { BrandMark } from "./BrandMark";
import { useI18n } from "../i18n";
import { PRODUCT_NAME } from "../brand";
import { ArrowLeft, Moon, ShieldCheck, Sun } from "lucide-react";

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<string | null>;
  onRegister: (username: string, password: string) => Promise<string | null>;
  onBack: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLogin,
  onRegister,
  onBack,
  theme,
  onToggleTheme,
}) => {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const switchMode = useCallback((nextMode: "login" | "register") => {
    setMode(nextMode);
    setError(null);
    setSuccess(null);
    setPassword("");
    setConfirmPassword("");
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!username.trim() || !password.trim() || submitting) return;
      setError(null);
      setSuccess(null);
      if (mode === "register") {
        if (password.length < 6) {
          setError(t("login.passwordTooShort"));
          return;
        }
        if (password !== confirmPassword) {
          setError(t("login.passwordMismatch"));
          return;
        }
      }
      setSubmitting(true);
      const err = mode === "login"
        ? await onLogin(username.trim(), password)
        : await onRegister(username.trim(), password);
      if (err) {
        setError(err);
        setSubmitting(false);
      } else if (mode === "register") {
        setMode("login");
        setPassword("");
        setConfirmPassword("");
        setSuccess(t("login.registrationSubmitted"));
        setSubmitting(false);
      }
    },
    [username, password, confirmPassword, submitting, mode, onLogin, onRegister, t]
  );

  return (
    <div className="login-page">
      <div className="login-page-grid" aria-hidden="true" />
      <div className="login-top-actions">
        <button type="button" className="login-back-button" onClick={onBack}>
          <ArrowLeft size={16} />{isZh ? "返回首页" : "Back home"}
        </button>
        <button
          type="button"
          className="login-theme-button"
          onClick={onToggleTheme}
          aria-label={theme === "light" ? "切换到暗色主题" : "切换到亮色主题"}
        >
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </button>
      </div>

      <section className="login-stage" aria-label={isZh ? "产品介绍" : "Product introduction"}>
        <BrandMark
          size={40}
          title={PRODUCT_NAME}
          subtitle={`${isZh ? "私有 AI 编程工作台" : "Private AI coding workbench"} · v0.7.0`}
          className="login-stage-brand"
        />
        <div className="login-stage-copy">
          <span className="login-stage-eyebrow"><i />{isZh ? "离线运行 · 数据不出内网" : "Offline runtime · Private by default"}</span>
          <h1>{isZh ? <>安静、可控的<br />Agent 工作台</> : <>A quiet, controlled<br />agent workbench</>}</h1>
          <p>{isZh
            ? "把编辑器当作画布，把任务当作主线。接入任意 OpenAI 兼容模型，在本地完成读写、审阅与协作。"
            : "Treat the editor as the canvas and the task as the through-line. Work with any OpenAI-compatible model on your own infrastructure."}</p>
        </div>
        <div className="login-workbench-preview" aria-hidden="true">
          <div className="login-preview-bar"><span /><span /><span /><code>workspace / src / auth.ts</code></div>
          <div className="login-preview-body">
            <div className="login-preview-rail"><i /><i /><i /><i /></div>
            <div className="login-preview-code">
              <p><b>12</b><em>export async function</em> signIn() {'{'}</p>
              <p><b>13</b>&nbsp;&nbsp;<em>const</em> session = <em>await</em> auth.create({'{'}</p>
              <p><b>14</b>&nbsp;&nbsp;&nbsp;&nbsp;mode: <u>"private"</u>,</p>
              <p><b>15</b>&nbsp;&nbsp;&nbsp;&nbsp;offline: <em>true</em>,</p>
              <p><b>16</b>&nbsp;&nbsp;{'}'});</p>
              <p><b>17</b>&nbsp;&nbsp;<em>return</em> session;</p>
            </div>
            <div className="login-preview-task"><span>Code · {isZh ? "运行中" : "Running"}</span><i /><i /><i /></div>
          </div>
        </div>
      </section>

      <section className="login-auth-stage">
        <form className="login-card" onSubmit={handleSubmit}>
          <div className="login-mode-tabs" role="tablist" aria-label={t("login.accountAccess")}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              className={mode === "login" ? "active" : ""}
              onClick={() => switchMode("login")}
            >
              {t("login.signIn")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              className={mode === "register" ? "active" : ""}
              onClick={() => switchMode("register")}
            >
              {t("login.register")}
            </button>
          </div>
          <div className="login-card-heading">
            <span>{isZh ? "工作区访问" : "Workspace access"}</span>
            <h2>{mode === "login" ? t("login.heading") : t("login.registerHeading")}</h2>
            <p>{mode === "login" ? t("login.description") : t("login.registerDescription")}</p>
          </div>
          {error && <div className="login-error" role="alert">{error}</div>}
          {success && <div className="login-success" role="status">{success}</div>}
          <label className="login-field" htmlFor="login-username">
            <span>{t("login.username")}</span>
            <input
              ref={inputRef}
              id="login-username"
              name="username"
              className="login-input"
              type="text"
              placeholder={isZh ? "输入用户名" : "Enter username"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="login-field" htmlFor="login-password">
            <span>{t("login.password")}</span>
            <input
              id="login-password"
              name="password"
              className="login-input"
              type="password"
              placeholder={isZh ? "输入密码" : "Enter password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {mode === "register" && (
            <label className="login-field" htmlFor="login-confirm-password">
              <span>{t("login.confirmPassword")}</span>
              <input
                id="login-confirm-password"
                name="confirmPassword"
                className="login-input"
                type="password"
                placeholder={t("login.confirmPasswordPlaceholder")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}
          <button
            className="login-btn"
            type="submit"
            disabled={
              !username.trim() ||
              !password.trim() ||
              (mode === "register" && !confirmPassword.trim()) ||
              submitting
            }
          >
            {submitting
              ? mode === "login" ? t("login.signingIn") : t("login.submittingRegistration")
              : mode === "login" ? t("login.signIn") : t("login.submitRegistration")}
          </button>
          <div className="login-footer">
            <ShieldCheck size={13} />
            <span>{mode === "login"
              ? t("login.localCredentialHint")
              : t("login.approvalHint")}</span>
          </div>
        </form>
      </section>
    </div>
  );
};
