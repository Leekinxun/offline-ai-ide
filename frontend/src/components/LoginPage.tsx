import React, { useState, useCallback, useRef, useEffect } from "react";
import { Code2 } from "lucide-react";

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<string | null>;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
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
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-logo">
          <Code2 size={32} />
          <span>AI IDE</span>
        </div>
        {error && <div className="login-error">{error}</div>}
        <input
          ref={inputRef}
          className="login-input"
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <input
          className="login-input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button
          className="login-btn"
          type="submit"
          disabled={!username.trim() || !password.trim() || submitting}
        >
          {submitting ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  );
};
