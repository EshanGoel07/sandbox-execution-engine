/**
 * k6 load test for the Virtual Judge API against the REAL (non-demo) stack.
 *
 *   API=http://localhost:3000 k6 run loadtest/submit.js
 *
 * setup() signs up one load-test user; every iteration then mirrors the
 * frontend:
 *   1. GET  /problems                          (list)
 *   2. POST /submissions  (Authorization: Bearer)  (enqueue a real submission)
 *   3. GET  /submissions/:id  * N              (poll until the worker is Done)
 *
 * This exercises the whole path: API -> Redis Stream -> worker pool ->
 * Docker sandbox -> Postgres, plus the read side under concurrent load.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const API = __ENV.API || "http://localhost:3000";
const PROBLEM_ID = Number(__ENV.PROBLEM_ID || 1);

const timeToVerdict = new Trend("time_to_verdict_ms", true);
const gradedOk = new Rate("graded_accepted");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "20s", target: 10 },
        { duration: "40s", target: 20 },
        { duration: "20s", target: 0 },
      ],
      gracefulStop: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:list}": ["p(95)<300"],
    "http_req_duration{endpoint:submit}": ["p(95)<500"],
  },
};

const SOLUTION = "a,b=map(int,input().split())\nprint(a+b)";

// Runs once, before the VUs ramp — create a user and hand its token to
// every iteration.
export function setup() {
  const email = `loadtest+${Date.now()}@example.com`;
  const res = http.post(
    `${API}/auth/signup`,
    JSON.stringify({ email, password: "loadtest-password" }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(res, { "signup 201": (r) => r.status === 201 });
  return { token: res.json("token") };
}

export default function (data) {
  const authJson = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
  };

  const list = http.get(`${API}/problems`, { tags: { endpoint: "list" } });
  check(list, { "list 200": (r) => r.status === 200 });

  const post = http.post(
    `${API}/submissions`,
    JSON.stringify({ problemId: PROBLEM_ID, language: "python", sourceCode: SOLUTION, stdin: "" }),
    { headers: authJson, tags: { endpoint: "submit" } }
  );
  check(post, { "submit 201": (r) => r.status === 201 });
  const submissionId = post.json("submissionId");
  if (!submissionId) return;

  const startedAt = Date.now();
  let verdict = null;
  for (let i = 0; i < 40; i++) {
    const got = http.get(`${API}/submissions/${submissionId}`, { tags: { endpoint: "poll" } });
    if (got.status === 200 && got.json("status") === "Done") {
      verdict = got.json("verdict");
      break;
    }
    sleep(0.5);
  }

  timeToVerdict.add(Date.now() - startedAt);
  gradedOk.add(verdict === "Accepted");
  check(null, { "reached a verdict": () => verdict !== null });

  sleep(1);
}
