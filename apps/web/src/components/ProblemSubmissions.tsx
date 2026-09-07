import { useEffect, useState } from "react";
import { getMyProblemSubmissions, SubmissionSummary } from "../api";
import VerdictBadge from "./VerdictBadge";

interface Props {
  problemId: number;
  refreshKey: number;
  loggedIn: boolean;
}

export default function ProblemSubmissions({ problemId, refreshKey, loggedIn }: Props) {
  const [subs, setSubs] = useState<SubmissionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loggedIn) return;
    setError(null);
    getMyProblemSubmissions(problemId)
      .then(setSubs)
      .catch((e) => setError(e?.message || String(e)));
  }, [problemId, refreshKey, loggedIn]);

  if (!loggedIn) {
    return (
      <div className="tab-empty">
        <p>Log in to see and track your submissions for this problem.</p>
      </div>
    );
  }

  if (error) return <p className="error">{error}</p>;
  if (!subs) return <p className="muted">Loading…</p>;
  if (subs.length === 0)
    return (
      <div className="tab-empty">
        <p>No submissions yet. Write a solution on the right and hit Submit.</p>
      </div>
    );

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>#</th>
          <th>When</th>
          <th>Language</th>
          <th>Verdict</th>
          <th>Tests</th>
        </tr>
      </thead>
      <tbody>
        {subs.map((s) => (
          <tr key={s.id}>
            <td className="muted">{s.id}</td>
            <td className="muted">{new Date(s.created_at).toLocaleString()}</td>
            <td>{s.language}</td>
            <td>
              <VerdictBadge status={s.status} verdict={s.verdict} />
            </td>
            <td className="muted">
              {s.passed_count != null && s.total_count != null
                ? `${s.passed_count}/${s.total_count}`
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
