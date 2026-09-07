import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import Editor from "@monaco-editor/react";
import { getProblem, submit, ProblemDetail as Problem } from "../api";
import { useAuth } from "../auth";
import ResultsView from "../components/ResultsView";
import ProblemSubmissions from "../components/ProblemSubmissions";

const LANGUAGES = [
  { id: "cpp", label: "C++", monaco: "cpp" },
  { id: "java", label: "Java", monaco: "java" },
  { id: "python", label: "Python", monaco: "python" },
] as const;

type LangId = (typeof LANGUAGES)[number]["id"];

const STARTERS: Record<LangId, string> = {
  cpp: `#include <iostream>
using namespace std;

int main() {
    int a, b;
    cin >> a >> b;
    cout << a + b << endl;
    return 0;
}
`,
  java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int a = sc.nextInt(), b = sc.nextInt();
        System.out.println(a + b);
    }
}
`,
  python: `a, b = map(int, input().split())
print(a + b)
`,
};

type Tab = "description" | "submissions";

export default function ProblemDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [problem, setProblem] = useState<Problem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("description");

  const [language, setLanguage] = useState<LangId>("cpp");
  const [code, setCode] = useState<string>(STARTERS.cpp);
  const [stdin, setStdin] = useState<string>("");
  const [touched, setTouched] = useState(false);

  const [submissionId, setSubmissionId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // bump to force the Submissions tab to reload after a new submission
  const [subsRefresh, setSubsRefresh] = useState(0);

  useEffect(() => {
    if (!id) return;
    getProblem(id).then(setProblem).catch((e) => setError(String(e)));
  }, [id]);

  function changeLanguage(next: LangId) {
    setLanguage(next);
    if (!touched) setCode(STARTERS[next]);
  }

  const monacoLang = useMemo(
    () => LANGUAGES.find((l) => l.id === language)!.monaco,
    [language]
  );

  async function onSubmit() {
    if (!problem) return;
    if (!user) {
      navigate(`/login?next=/problems/${problem.id}`);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setSubmissionId(null);
    try {
      const res = await submit({
        problemId: problem.id,
        language,
        sourceCode: code,
        stdin,
      });
      setSubmissionId(res.submissionId);
      setSubsRefresh((n) => n + 1);
    } catch (e: any) {
      setSubmitError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <p className="page-message error">{error}</p>;
  if (!problem) return <p className="page-message muted">Loading…</p>;

  return (
    <div className="workspace">
      {/* LEFT: problem statement + submissions tab */}
      <section className="pane pane-left">
        <div className="tabbar">
          <button
            className={tab === "description" ? "tab active" : "tab"}
            onClick={() => setTab("description")}
          >
            Description
          </button>
          <button
            className={tab === "submissions" ? "tab active" : "tab"}
            onClick={() => setTab("submissions")}
          >
            Submissions
          </button>
        </div>

        <div className="pane-scroll">
          {tab === "description" ? (
            <article className="problem">
              <div className="crumbs">
                <Link to="/">Problems</Link>
                <span>/</span>
                <span>#{problem.id}</span>
              </div>
              <h1 className="problem-title">{problem.title}</h1>
              <div className="problem-meta">
                <span>{problem.testCaseCount} test cases</span>
                <span>·</span>
                <span>{problem.timeLimitMs} ms limit</span>
              </div>
              {problem.statement ? (
                <div className="statement">{problem.statement}</div>
              ) : (
                <p className="muted">No statement provided.</p>
              )}
            </article>
          ) : (
            <ProblemSubmissions
              problemId={problem.id}
              refreshKey={subsRefresh}
              loggedIn={!!user}
            />
          )}
        </div>
      </section>

      {/* RIGHT: editor + controls + results */}
      <section className="pane pane-right">
        <div className="editor-toolbar">
          <div className="lang-select">
            <label htmlFor="lang">Language</label>
            <select
              id="lang"
              value={language}
              onChange={(e) => changeLanguage(e.target.value as LangId)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={onSubmit} disabled={submitting}>
            {submitting ? "Submitting…" : user ? "Submit" : "Log in to submit"}
          </button>
        </div>

        <div className="editor-wrap">
          <Editor
            height="100%"
            language={monacoLang}
            theme="vs-dark"
            value={code}
            onChange={(v) => {
              setCode(v ?? "");
              setTouched(true);
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              padding: { top: 12 },
            }}
          />
        </div>

        <div className="io-panel">
          <label className="io-label" htmlFor="stdin">
            Custom stdin <span className="muted">(optional — stored with the submission; grading uses the problem's own tests)</span>
          </label>
          <textarea
            id="stdin"
            className="stdin"
            rows={2}
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
            placeholder="e.g. 2 3"
          />

          {submitError && <p className="error inline-error">{submitError}</p>}

          {submissionId !== null && (
            <ResultsView key={submissionId} submissionId={submissionId} />
          )}
        </div>
      </section>
    </div>
  );
}
