import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { getProfile, Profile as ProfileData } from "../api";
import { useAuth } from "../auth";
import VerdictBadge from "../components/VerdictBadge";

export default function Profile() {
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    getProfile().then(setData).catch((e) => setError(e?.message || String(e)));
  }, [user]);

  if (authLoading) return <p className="page-message muted">Loading…</p>;
  if (!user) return <Navigate to="/login?next=/profile" replace />;
  if (error) return <p className="page-message error">{error}</p>;
  if (!data) return <p className="page-message muted">Loading…</p>;

  const { stats, submissions } = data;
  const acceptancePct = (stats.acceptanceRate * 100).toFixed(
    stats.totalSubmissions ? 1 : 0
  );

  return (
    <div className="container">
      <div className="profile-head">
        <h1>{data.user.email}</h1>
        <span className="muted">
          member since {new Date(data.user.created_at).toLocaleDateString()}
        </span>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-value">{stats.solvedCount}</div>
          <div className="stat-label">Problems solved</div>
        </div>
        <div className="stat">
          <div className="stat-value">{acceptancePct}%</div>
          <div className="stat-label">
            Acceptance rate ({stats.acceptedSubmissions}/{stats.totalSubmissions})
          </div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.totalSubmissions}</div>
          <div className="stat-label">Total submissions</div>
        </div>
      </div>

      <h2 style={{ fontSize: 15, marginBottom: 12 }}>Submission history</h2>
      {submissions.length === 0 ? (
        <p className="muted">
          No submissions yet. <Link to="/">Pick a problem</Link> to get started.
        </p>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>#</th>
                <th>Problem</th>
                <th style={{ width: 90 }}>Language</th>
                <th style={{ width: 130 }}>Verdict</th>
                <th style={{ width: 80 }}>Tests</th>
                <th style={{ width: 170 }}>When</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id}>
                  <td className="muted">{s.id}</td>
                  <td>
                    <Link to={`/problems/${s.problem_id}`}>{s.problem_title}</Link>
                  </td>
                  <td>{s.language}</td>
                  <td>
                    <VerdictBadge status={s.status} verdict={s.verdict} />
                  </td>
                  <td className="muted">
                    {s.passed_count != null && s.total_count != null
                      ? `${s.passed_count}/${s.total_count}`
                      : "—"}
                  </td>
                  <td className="muted">{new Date(s.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
