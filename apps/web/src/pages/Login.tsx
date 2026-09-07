import { FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { login } from "../api";
import { useAuth } from "../auth";

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";
  const { setSession } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await login(email.trim(), password);
      setSession(token, user);
      navigate(next, { replace: true });
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container-narrow">
      <div className="card auth-card">
        <h1>Log in</h1>
        <p className="page-sub">Welcome back.</p>

        <form onSubmit={onSubmit}>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="error inline-error">{error}</p>}

          <button className="btn btn-primary btn-block" type="submit" disabled={busy} style={{ marginTop: 8 }}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>

        <p className="auth-alt">
          No account? <Link to={`/signup${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign up</Link>
        </p>
      </div>
    </div>
  );
}
