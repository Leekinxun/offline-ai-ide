import React, { useState, useCallback, useRef, useEffect } from "react";
import { BrandMark } from "./BrandMark";
import { useI18n } from "../i18n";
import { PRODUCT_NAME } from "../brand";
import { ArrowLeft, Moon, ShieldCheck, Sun } from "lucide-react";

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<string | null>;
  onBack: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLogin,
  onBack,
  theme,
  onToggleTheme,
}) => {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!username.trim() || !password.trim() || submitting) return;
      setError(null);
      setSubmitting(true);
      const err = await onLogin(username.trim(), password);
      if (err) {
        setError(err);
        setSubmitting(false);
      }
    },
    [username, password, submitting, onLogin]
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
          <div className="login-card-heading">
            <span>{isZh ? "工作区访问" : "Workspace access"}</span>
            <h2>{isZh ? "登录 CrownForge" : "Sign in to CrownForge"}</h2>
            <p>{t("login.description")}</p>
          </div>
          {error && <div className="login-error" role="alert">{error}</div>}
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
              autoComplete="current-password"
            />
          </label>
          <button
            className="login-btn"
            type="submit"
            disabled={!username.trim() || !password.trim() || submitting}
          >
            {submitting ? t("login.signingIn") : t("login.signIn")}
          </button>
          <div className="login-footer">
            <ShieldCheck size={13} />
            <span>{isZh ? "凭据只发送到本地 CrownForge 服务" : "Credentials are sent only to your local CrownForge service"}</span>
          </div>
        </form>
      </section>
    </div>
  );
};
