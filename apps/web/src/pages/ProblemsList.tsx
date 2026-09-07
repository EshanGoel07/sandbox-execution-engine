import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProblems, ProblemListItem } from "../api";

export default function ProblemsList() {
  const [problems, setProblems] = useState<ProblemListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProblems().then(setProblems).catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="page-message error">Couldn't load problems: {error}</p>;

  return (
    <div className="container">
      <h1 className="page-title">Problems</h1>
      <p className="page-sub">
        Pick a problem, write a solution, and get an instant verdict against every test case.
      </p>

      {!problems ? (
        <p className="muted">Loading…</p>
      ) : problems.length === 0 ? (
        <p className="muted">No problems yet.</p>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>#</th>
                <th>Title</th>
                <th style={{ width: 120 }}>Test cases</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((p) => (
                <tr key={p.id} className="problem-row">
                  <td className="muted">{p.id}</td>
                  <td>
                    <Link to={`/problems/${p.id}`}>{p.title}</Link>
                  </td>
                  <td className="muted">{p.testCaseCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
