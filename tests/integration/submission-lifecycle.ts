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
import { runMigrations, pool } from "@vj/infra";
import { WorkerPool } from "@vj/worker";
import { startApiServer } from "@vj/api";

const PORT = 3099;
const BASE_URL = `http://localhost:${PORT}`;

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

function collectUpdatesUntilDone(submissionId: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const updates: any[] = [];
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out waiting for submission ${submissionId} to finish`));
    }, 20000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", submissionId }));
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
