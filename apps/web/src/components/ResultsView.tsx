import { useEffect, useRef, useState } from "react";
import { WS_URL, getSubmission, SubmissionDetail } from "../api";
import VerdictBadge from "./VerdictBadge";

interface LiveState {
  status: string;
  verdict: string | null;
  passedCount: number | null;
  totalCount: number | null;
  failedOrdinal: number | null;
  message: string | null;
}

const STEPS = ["Queued", "Judging", "Done"] as const;

function stepIndex(status: string): number {
  if (status === "Pending" || status === "Queued") return 0;
  if (status === "Judging") return 1;
  return 2; // Done
}

export default function ResultsView({ submissionId }: { submissionId: number }) {
  const [live, setLive] = useState<LiveState>({
    status: "Queued",
    verdict: null,
    passedCount: null,
    totalCount: null,
    failedOrdinal: null,
    message: null,
  });
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [wsError, setWsError] = useState(false);
  const settled = useRef(false);

  useEffect(() => {
    let disposed = false;
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", submissionId }));
    };
    ws.onmessage = (ev) => {
      const u = JSON.parse(ev.data);
      setLive((prev) => ({
        status: u.status ?? prev.status,
        verdict: u.verdict ?? prev.verdict,
        passedCount: u.passedCount ?? prev.passedCount,
        totalCount: u.totalCount ?? prev.totalCount,
        failedOrdinal: u.failedOrdinal ?? prev.failedOrdinal,
        message: u.message ?? prev.message,
      }));
      if (u.status === "Done") {
        settled.current = true;
        // The WS stream carries the aggregate verdict but not the
        // per-test-case breakdown — pull that from the REST endpoint once.
        getSubmission(submissionId).then(setDetail).catch(() => {});
        ws.close();
      }
    };
    // Only surface a connection problem if it happens before we've got a
    // terminal update and wasn't just this effect being torn down (React
    // StrictMode mounts effects twice in dev).
    ws.onerror = () => {
      if (!disposed && !settled.current) setWsError(true);
    };

    return () => {
      disposed = true;
      ws.close();
    };
  }, [submissionId]);

  // REST backstop: the WebSocket gives snappy live transitions, but a
  // fully-broken WS path (or DEMO_MODE, where the verdict already exists the
  // instant the submission is created) shouldn't leave the view stuck. Poll
  // until the submission is Done, then stop.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || settled.current) return;
      try {
        const d = await getSubmission(submissionId);
        if (stop) return;
        setDetail(d);
        setLive((prev) => ({
          status: d.status ?? prev.status,
          verdict: d.verdict ?? prev.verdict,
          passedCount: d.passed_count ?? prev.passedCount,
          totalCount: d.total_count ?? prev.totalCount,
          failedOrdinal: d.failed_test_ordinal ?? prev.failedOrdinal,
          message: d.message ?? prev.message,
        }));
        if (d.status === "Done") {
          settled.current = true;
          return;
        }
      } catch {
        /* keep polling */
      }
      setTimeout(tick, 1500);
    };
    const first = setTimeout(tick, 600);
    return () => {
      stop = true;
      clearTimeout(first);
    };
  }, [submissionId]);

  const current = stepIndex(live.status);
  const done = live.status === "Done";

  return (
    <div className="results">
      <div className="results-head">
        <h3>Submission #{submissionId}</h3>
        {done && <VerdictBadge status="Done" verdict={live.verdict} />}
      </div>

      <ol className="steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={
              i < current ? "step past" : i === current ? "step active" : "step"
            }
          >
            <span className="dot" />
            {label}
            {label === "Judging" && i === current && !done && <span className="spin"> …</span>}
          </li>
        ))}
      </ol>

      {wsError && !done && (
        <p className="muted">
          Live connection unavailable — falling back to polling the API for the verdict.
        </p>
      )}

      {live.message && <p className="demo-note">{live.message}</p>}

      {done && live.totalCount != null && live.verdict !== "Not Run (demo)" && (
        <p className="muted">
          Passed {live.passedCount ?? 0} / {live.totalCount} test cases
          {live.failedOrdinal != null && (
            <> — stopped at test #{live.failedOrdinal}</>
          )}
          .
        </p>
      )}

      {detail && detail.results.length > 0 && (
        <table className="tc-table">
          <thead>
            <tr>
              <th>Test</th>
              <th>Verdict</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {detail.results.map((r) => (
              <tr key={r.test_case_ordinal}>
                <td>#{r.test_case_ordinal}</td>
                <td className={r.verdict === "Accepted" ? "v-ok" : "v-bad"}>
                  {r.verdict === "Accepted" ? "✓ " : "✗ "}
                  {r.verdict}
                </td>
                <td className="muted">{r.time_ms != null ? `${r.time_ms} ms` : "—"}</td>
              </tr>
            ))}
            {detail.failed_test_ordinal != null &&
              detail.total_count != null &&
              detail.results.length < detail.total_count && (
                <tr>
                  <td colSpan={3} className="muted skipped">
                    tests #{detail.results.length + 1}–#{detail.total_count} not run
                    (grading stops at the first failure)
                  </td>
                </tr>
              )}
          </tbody>
        </table>
      )}
    </div>
  );
}
