/**
 * k6 load test for the PUBLIC execution API (/api/v1) against the real stack.
 *
 *   API=http://localhost:3000 k6 run loadtest/executions.js
 *
 * Where submit.js measures the judge's /app tree, this measures what the
 * public API adds on its request path: API-key auth (one SHA-256 + one
 * indexed lookup), the per-account sliding-window rate limit, and the atomic
 * quota + concurrency check — each a single Redis round trip — on top of the
 * same INSERT + XADD. `endpoint:execute` p95 is the number to watch.
 *
 * The API's usage controls have to be relaxed for this (see
 * loadtest/README.md): each VU polls faster than the default 120 requests/min.
 *
 * setup() creates one account + one API key PER VU, through the same curl-able
 * flow a developer uses (signup -> POST /app/api-keys). Each iteration:
 *   1. POST /api/v1/executions            (queue a real Python run)
 *   2. GET  /api/v1/executions/:id  * N   (poll until completed)
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const API = __ENV.API || "http://localhost:3000";
const PEAK_VUS = Number(__ENV.PEAK_VUS || 20);

const timeToResult = new Trend("time_to_result_ms", true);
const completedOk = new Rate("completed_ok");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "20s", target: Math.round(PEAK_VUS / 2) },
        { duration: "40s", target: PEAK_VUS },
        { duration: "20s", target: 0 },
      ],
      gracefulStop: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:execute}": ["p(95)<500"],
    "http_req_duration{endpoint:execution_get}": ["p(95)<300"],
  },
};

const PROGRAM = {
  language: "python",
  source_code: "a, b = map(int, input().split())\nprint(a + b)",
  stdin: "3 4\n",
};

export function setup() {
  const keys = [];
  for (let i = 0; i < PEAK_VUS; i++) {
    const email = `loadtest-api+${Date.now()}-${i}@example.com`;
    const signup = http.post(
      `${API}/app/auth/signup`,
      JSON.stringify({ email, password: "loadtest-password" }),
      { headers: { "Content-Type": "application/json" } }
    );
    check(signup, { "signup 201": (r) => r.status === 201 });
    const key = http.post(`${API}/app/api-keys`, JSON.stringify({ name: "loadtest" }), {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signup.json("token")}` },
    });
    check(key, { "key 201": (r) => r.status === 201 });
    keys.push(key.json("key"));
  }
  return { keys };
}

export default function (data) {
  const key = data.keys[(__VU - 1) % data.keys.length];
  const auth = { Authorization: `Bearer ${key}` };

  const post = http.post(`${API}/api/v1/executions`, JSON.stringify(PROGRAM), {
    headers: { ...auth, "Content-Type": "application/json" },
    tags: { endpoint: "execute" },
  });
  check(post, { "execute 202": (r) => r.status === 202 });
  const id = post.json("id");
  if (!id) return;

  const startedAt = Date.now();
  let execution = null;
  for (let i = 0; i < 40; i++) {
    const got = http.get(`${API}/api/v1/executions/${id}`, {
      headers: auth,
      tags: { endpoint: "execution_get" },
    });
    if (got.status === 200 && got.json("status") === "completed") {
      execution = got.json();
      break;
    }
    sleep(0.5);
  }

  timeToResult.add(Date.now() - startedAt);
  completedOk.add(execution !== null && execution.result.outcome === "ok" && execution.result.stdout === "7\n");
  check(null, { "reached a result": () => execution !== null });

  sleep(1);
}
