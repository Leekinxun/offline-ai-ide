import React, { useState, useCallback, useRef, useEffect } from "react";
import { BrandMark } from "./BrandMark";
import { useI18n } from "../i18n";

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<string | null>;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const { t } = useI18n();
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
      <form className="login-card" onSubmit={handleSubmit}>
        <BrandMark
          size={54}
          title="AI IDE"
          subtitle={t("login.privateWorkspace")}
          stacked
          className="login-logo"
        />
        <p className="login-description">{t("login.description")}</p>
        {error && <div className="login-error" role="alert">{error}</div>}
        <label className="sr-only" htmlFor="login-username">{t("login.username")}</label>
        <input
          ref={inputRef}
          id="login-username"
          name="username"
          className="login-input"
          type="text"
          placeholder={t("login.username")}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <label className="sr-only" htmlFor="login-password">{t("login.password")}</label>
        <input
          id="login-password"
          name="password"
          className="login-input"
          type="password"
          placeholder={t("login.password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button
          className="login-btn"
          type="submit"
          disabled={!username.trim() || !password.trim() || submitting}
        >
          {submitting ? t("login.signingIn") : t("login.signIn")}
        </button>
        <div className="login-footer">
          <span className="login-status-dot" />
          <span>{t("app.offline")}</span>
          <span>·</span>
          <span>{t("login.privateWorkspace")}</span>
        </div>
      </form>
    </div>
  );
};
