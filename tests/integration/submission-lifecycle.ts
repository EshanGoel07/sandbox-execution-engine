/**
 * End-to-end: POST a problem with multiple test cases, sign up, POST a
 * submission, subscribe over a real WebSocket, and confirm the real-time
 * push matches what lands in Postgres — for a submission that passes every
 * test case and one that fails partway through. Also checks auth is enforced
 * and the public problem endpoint doesn't leak expected outputs.
 *
 * Requires Postgres + Redis + Docker running, and JWT_SECRET set (the npm
 * script sets it; auth refuses to load without one).
 */
import {
  runMigrations,
  pool,
  createSubmission,
  enqueueSubmission,
  pendingCount,
} from "@vj/infra";
import { WorkerPool } from "@vj/worker";
import { startApiServer } from "@vj/api";

const PORT = 3099;
// The judge's session-auth tree. (The WebSocket hub stays at /ws.)
const BASE_URL = `http://localhost:${PORT}/app`;

let authToken: string | null = null;

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  return { status: res.status, body: await res.json() };
}

function collectUpdatesUntilDone(submissionId: number, token = authToken): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const updates: any[] = [];
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out waiting for submission ${submissionId} to finish`));
    }, 20000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", submissionId, token }));
    });
    ws.addEventListener("message", (event) => {
      const update = JSON.parse(event.data.toString());
      updates.push(update);
      if (update.status === "Done") {
        clearTimeout(timer);
        ws.close();
        resolve(updates);
      }
    });
    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  let allPass = true;
  const fail = (msg: string) => {
    console.log(`FAIL: ${msg}`);
    allPass = false;
  };

  await runMigrations();
  const server = await startApiServer(PORT);
  console.log(`api-gateway listening on :${PORT}`);

  const workerPool = new WorkerPool({
    count: 2,
    waitMs: 1000,
    onResult: (outcome, consumerName) => {
      console.log(
        `[${consumerName}] submission ${outcome.submissionId} -> ${outcome.gradeResult.verdict} ` +
          `(${outcome.gradeResult.passedCount}/${outcome.gradeResult.totalCount})`
      );
    },
  });
  workerPool.start();

  try {
    // --- auth: submissions require a logged-in user ---
    const email = `m3-${Date.now()}@example.com`;
    const signup = await postJson("/auth/signup", { email, password: "test-password-123" });
    if (signup.status !== 201) fail(`POST /auth/signup returned ${signup.status}`);
    authToken = signup.body.token;
    if (!authToken) fail("signup did not return a token");

    const noAuth = await fetch(`${BASE_URL}/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problemId: 1, language: "cpp", sourceCode: "x" }),
    });
    if (noAuth.status !== 401) fail(`unauthenticated POST /submissions should be 401, got ${noAuth.status}`);

    // POST /problems is authoring, not public — must reject an anonymous caller.
    const noAuthProblem = await fetch(`${BASE_URL}/problems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", testCases: [{ input: "1", expectedOutput: "1" }] }),
    });
    if (noAuthProblem.status !== 401)
      fail(`unauthenticated POST /problems should be 401, got ${noAuthProblem.status}`);

    // GET /submissions/:id also needs a session now.
    const noAuthGet = await fetch(`${BASE_URL}/submissions/1`);
    if (noAuthGet.status !== 401)
      fail(`unauthenticated GET /submissions/:id should be 401, got ${noAuthGet.status}`);

    // --- create a problem with 3 test cases ---
    const created = await postJson("/problems", {
      title: "Sum Two Numbers",
      timeLimitMs: 5000,
      testCases: [
        { input: "1 2", expectedOutput: "3" },
        { input: "10 20", expectedOutput: "30" },
        { input: "5 5", expectedOutput: "10" },
      ],
    });
    if (created.status !== 201) fail(`POST /problems returned ${created.status}`);
    const problemId = created.body.id;
    console.log("created problem:", problemId);

    const publicProblem = await getJson(`/problems/${problemId}`);
    if (publicProblem.status !== 200) fail(`GET /problems/:id returned ${publicProblem.status}`);
    if (JSON.stringify(publicProblem.body).includes("expectedOutput")) {
      fail("public problem response leaked test case answers");
    }
    if (publicProblem.body.testCaseCount !== 3) fail("expected testCaseCount 3");

    // --- submission 1: correct for all 3 test cases ---
    const goodSubmission = await postJson("/submissions", {
      problemId,
      language: "cpp",
      sourceCode: `#include <iostream>
int main() { int a, b; std::cin >> a >> b; std::cout << a + b; }`,
    });
    if (goodSubmission.status !== 201) fail(`POST /submissions returned ${goodSubmission.status}`);
    const goodId = goodSubmission.body.submissionId;
    console.log("submitted correct solution:", goodId);

    const goodUpdates = await collectUpdatesUntilDone(goodId);
    const goodFinal = goodUpdates[goodUpdates.length - 1];
    if (goodFinal.verdict !== "Accepted") fail(`expected Accepted, got ${goodFinal.verdict}`);
    if (goodFinal.passedCount !== 3 || goodFinal.totalCount !== 3) fail("expected 3/3 passed");

    const goodFromDb = await getJson(`/submissions/${goodId}`);
    if (goodFromDb.body.status !== "Done") fail("DB status should be Done");
    if (goodFromDb.body.verdict !== "Accepted") fail("DB verdict should be Accepted");
    if (goodFromDb.body.results.length !== 3) fail("expected 3 stored per-test results");

    // --- submission 2: bug (subtracts) fails the first test case ---
    const buggySubmission = await postJson("/submissions", {
      problemId,
      language: "cpp",
      sourceCode: `#include <iostream>
int main() { int a, b; std::cin >> a >> b; std::cout << a - b; }`,
    });
    const buggyId = buggySubmission.body.submissionId;
    console.log("submitted buggy solution:", buggyId);

    const buggyUpdates = await collectUpdatesUntilDone(buggyId);
    const buggyFinal = buggyUpdates[buggyUpdates.length - 1];
    if (buggyFinal.verdict !== "Wrong Answer") fail(`expected Wrong Answer, got ${buggyFinal.verdict}`);
    if (buggyFinal.passedCount !== 0) fail(`expected 0 passed before failing, got ${buggyFinal.passedCount}`);
    if (buggyFinal.failedOrdinal !== 1) fail(`expected failure at ordinal 1, got ${buggyFinal.failedOrdinal}`);

    const buggyFromDb = await getJson(`/submissions/${buggyId}`);
    if (buggyFromDb.body.results.length !== 1) {
      fail(`expected grading to stop after 1 test case, got ${buggyFromDb.body.results.length} stored results`);
    }

    // --- profile reflects the two submissions ---
    const profile = await getJson("/profile");
    if (profile.status !== 200) fail(`GET /profile returned ${profile.status}`);
    if (profile.body.user.email !== email) fail("profile email mismatch");
    if (profile.body.stats.solvedCount !== 1) fail(`expected solvedCount 1, got ${profile.body.stats.solvedCount}`);
    if (profile.body.stats.totalSubmissions !== 2) fail(`expected totalSubmissions 2, got ${profile.body.stats.totalSubmissions}`);
    if (profile.body.stats.acceptedSubmissions !== 1) fail(`expected acceptedSubmissions 1, got ${profile.body.stats.acceptedSubmissions}`);
    if (profile.body.submissions.length !== 2) fail(`expected 2 submissions in history, got ${profile.body.submissions.length}`);

    const perProblem = await getJson(`/problems/${problemId}/submissions`);
    if (perProblem.status !== 200) fail(`GET /problems/:id/submissions returned ${perProblem.status}`);
    if (perProblem.body.length !== 2) fail(`expected 2 submissions for the problem, got ${perProblem.body.length}`);

    // --- a second user cannot read the first user's submission ---
    // 404 (not 403): the status code must not confirm the id exists.
    const otherSignup = await postJson("/auth/signup", {
      email: `m3-other-${Date.now()}@example.com`,
      password: "test-password-123",
    });
    const otherToken = otherSignup.body.token;
    const asOther = await fetch(`${BASE_URL}/submissions/${goodId}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    if (asOther.status !== 404)
      fail(`second user reading someone else's submission should be 404, got ${asOther.status}`);

    // --- the response is trimmed to what the client reads ---
    if ("source_code" in goodFromDb.body || "user_id" in goodFromDb.body || "stdin" in goodFromDb.body) {
      fail("GET /submissions/:id leaked source_code / user_id / stdin");
    }

    // --- unknown language rejected at the API boundary (no row, no enqueue) ---
    const badLang = await postJson("/submissions", {
      problemId,
      language: "rust",
      sourceCode: "fn main() {}",
    });
    if (badLang.status !== 400) fail(`unknown language should be 400, got ${badLang.status}`);

    // --- poison message: a bad-language row injected past the API still drains ---
    const poisonId = await createSubmission({
      problemId,
      language: "brainfuck",
      sourceCode: "+[]",
      userId: undefined,
    });
    await enqueueSubmission(poisonId);
    let poisonVerdict: string | null = null;
    for (let i = 0; i < 40; i++) {
      const r = await pool.query("SELECT status, verdict FROM submissions WHERE id = $1", [poisonId]);
      if (r.rows[0].status === "Done") {
        poisonVerdict = r.rows[0].verdict;
        break;
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    if (poisonVerdict !== "Internal Error")
      fail(`poison message should end as Internal Error, got ${poisonVerdict}`);
    const pending = await pendingCount();
    if (pending !== 0) fail(`poison message left ${pending} unacked messages on the stream`);

    // --- submission rate limit returns 429 ---
    // test:integration sets SUBMISSION_RATE_MAX low; keep submitting until one 429s.
    let saw429 = false;
    for (let i = 0; i < 15; i++) {
      const r = await postJson("/submissions", {
        problemId,
        language: "cpp",
        sourceCode: `#include <iostream>
int main() { int a, b; std::cin >> a >> b; std::cout << a + b; }`,
      });
      if (r.status === 429) {
        saw429 = true;
        if (!r.body.error) fail("429 response should carry an { error } message");
        break;
      }
    }
    if (!saw429) fail("expected a 429 from the submission rate limit");

    console.log(allPass ? "PASS" : "FAIL");
  } finally {
    await workerPool.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
