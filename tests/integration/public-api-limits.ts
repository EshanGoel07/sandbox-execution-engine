/**
 * The public API's three usage controls, against a real API, worker pool,
 * Redis and Docker — run with deliberately tiny limits (see the npm script):
 * 5 requests / 3 s, 2 executions in flight, 4 executions / day.
 *
 *   - rate limit: sliding window, X-RateLimit-* counting down, 429
 *     `rate_limited` + Retry-After, and it reopens once the window slides
 *   - concurrency cap: a third in-flight execution is 429
 *     `concurrency_limited`; the worker frees the slot when one finishes
 *   - daily quota: the fifth accepted execution is 429 `quota_exceeded`
 *     with Retry-After to UTC midnight; a rejected (400) request costs nothing
 *   - all three are per ACCOUNT: a second key of the same account is
 *     throttled too, while another account is unaffected
 *   - a leaked in-flight slot (worker crashed before freeing it) blocks only
 *     until its expiry, then heals itself
 *   - throttled requests are still attributed to the key that made them
 *
 * Waits on executions by reading Postgres directly, so the test's own
 * polling never spends the tiny rate limit it's measuring.
 */
import { createRedis, inflightKey, pool, runMigrations } from "@vj/infra";
import { WorkerPool, processOneExecution } from "@vj/worker";
import { startApiServer, flushUsage } from "@vj/api";
import { contractViolation } from "./contract";

const PORT = 3097;
const ROOT = `http://localhost:${PORT}`;
const RATE_MAX = Number(process.env.API_RATE_LIMIT_MAX);
const RATE_WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS);
const MAX_CONCURRENT = Number(process.env.API_MAX_CONCURRENT_EXECUTIONS);
const DAILY_QUOTA = Number(process.env.API_DAILY_EXECUTION_QUOTA);

interface Res {
  status: number;
  headers: Headers;
  body: any;
}

async function call(method: string, path: string, bearer?: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Long enough that two of these are reliably in flight together.
const SLOW = { language: "python", source_code: "import time\ntime.sleep(2)\nprint('done')" };
const FAST = { language: "python", source_code: "print('hi')" };

async function waitUntilTerminal(ids: string[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await pool.query(
      "SELECT COUNT(*) AS n FROM executions WHERE id = ANY($1) AND status IN ('completed', 'failed')",
      [ids]
    );
    if (Number(r.rows[0].n) === ids.length) return;
    await sleep(200);
  }
  throw new Error(`executions never finished: ${ids.join(", ")}`);
}

async function main() {
  let allPass = true;
  const fail = (msg: string) => {
    console.log(`FAIL: ${msg}`);
    allPass = false;
  };
  const ok = (msg: string) => console.log(`ok: ${msg}`);
  const expect429 = (label: string, r: Res, code: string) => {
    if (r.status !== 429 || r.body?.error?.code !== code) {
      fail(`${label}: expected 429 ${code}, got ${r.status} ${JSON.stringify(r.body)}`);
      return;
    }
    const violation = contractViolation("Error", r.body);
    if (violation) fail(`${label}: not the documented error envelope: ${violation}`);
    if (!/^\d+$/.test(r.headers.get("retry-after") ?? "")) fail(`${label}: 429 without a Retry-After header`);
  };
  // Starts a fresh rate-limit window for the next scenario.
  const letWindowSlide = () => sleep(RATE_WINDOW_MS + 200);

  if (![RATE_MAX, RATE_WINDOW_MS, MAX_CONCURRENT, DAILY_QUOTA].every(Number.isInteger)) {
    throw new Error("run via `npm run test:public-api-limits` (sets the tiny limits)");
  }

  await runMigrations();
  const server = await startApiServer(PORT);
  const executors = new WorkerPool({
    count: 3,
    waitMs: 1000,
    name: "limits-executor",
    processOne: processOneExecution,
  });
  executors.start();
  const redis = createRedis();

  const stamp = Date.now();
  async function account(tag: string): Promise<{ jwt: string; userId: number; keys: { id: number; key: string }[] }> {
    const signup = await call("POST", "/app/auth/signup", undefined, {
      email: `limits-${tag}-${stamp}@example.com`,
      password: "test-password-123",
    });
    const jwt = signup.body.token;
    const keys = [];
    for (const name of ["one", "two"]) {
      const k = await call("POST", "/app/api-keys", jwt, { name });
      keys.push({ id: k.body.id, key: k.body.key });
    }
    return { jwt, userId: signup.body.user.id, keys };
  }

  try {
    // --- rate limit: sliding window, per account -------------------------------------
    const r = await account("rate");
    const other = await account("other");
    const remaining: number[] = [];
    for (let i = 0; i < RATE_MAX; i++) {
      const res = await call("GET", "/api/v1/languages", r.keys[0].key);
      if (res.status !== 200) fail(`request ${i + 1} of ${RATE_MAX} should pass, got ${res.status}`);
      if (Number(res.headers.get("x-ratelimit-limit")) !== RATE_MAX) fail("X-RateLimit-Limit is wrong");
      remaining.push(Number(res.headers.get("x-ratelimit-remaining")));
      const resetIn = Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
      if (!(resetIn > -2000 && resetIn <= RATE_WINDOW_MS + 2000))
        fail(`X-RateLimit-Reset should be within one window from now, is ${resetIn}ms away`);
    }
    if (JSON.stringify(remaining) !== JSON.stringify([4, 3, 2, 1, 0]))
      fail(`X-RateLimit-Remaining should count down 4..0, got ${remaining}`);

    const over = await call("GET", "/api/v1/languages", r.keys[0].key);
    expect429("request over the rate limit", over, "rate_limited");
    const retryAfter = Number(over.headers.get("retry-after"));
    if (!(retryAfter >= 1 && retryAfter <= Math.ceil(RATE_WINDOW_MS / 1000)))
      fail(`Retry-After should be within the window, got ${retryAfter}`);
    expect429("same account, different key", await call("GET", "/api/v1/languages", r.keys[1].key), "rate_limited");
    const otherAccount = await call("GET", "/api/v1/languages", other.keys[0].key);
    if (otherAccount.status !== 200) fail(`another account must be unaffected, got ${otherAccount.status}`);
    else ok("rate limit: 5 pass, 6th is 429, shared by the account's keys, other accounts unaffected");

    await letWindowSlide();
    const reopened = await call("GET", "/api/v1/languages", r.keys[0].key);
    if (reopened.status !== 200) fail(`after the window slides, requests should pass again, got ${reopened.status}`);
    else ok("rate limit: reopens once the window has slid past the old requests");

    // --- concurrency cap, per account --------------------------------------------------
    const c = await account("concurrency");
    const first = await call("POST", "/api/v1/executions", c.keys[0].key, SLOW);
    const second = await call("POST", "/api/v1/executions", c.keys[0].key, SLOW);
    if (first.status !== 202 || second.status !== 202)
      fail(`the first ${MAX_CONCURRENT} executions should be accepted, got ${first.status}/${second.status}`);
    expect429("third in-flight execution", await call("POST", "/api/v1/executions", c.keys[0].key, SLOW), "concurrency_limited");
    expect429(
      "third in-flight execution via the account's other key",
      await call("POST", "/api/v1/executions", c.keys[1].key, SLOW),
      "concurrency_limited"
    );
    await waitUntilTerminal([first.body.id, second.body.id]);
    await letWindowSlide();
    const afterFree = await call("POST", "/api/v1/executions", c.keys[1].key, FAST);
    if (afterFree.status !== 202) fail(`once executions finish their slots free up, got ${afterFree.status}`);
    else ok("concurrency: 3rd in-flight is 429 on either key; the worker frees slots on completion");
    await waitUntilTerminal([afterFree.body.id]);

    // --- daily quota, per account ------------------------------------------------------
    const q = await account("quota");
    const invalid = await call("POST", "/api/v1/executions", q.keys[0].key, { language: "rust", source_code: "x" });
    if (invalid.status !== 400) fail(`invalid request should be 400, got ${invalid.status}`);
    const accepted: string[] = [];
    // Two at a time (the concurrency cap), spread across both keys.
    for (let round = 0; round < DAILY_QUOTA / MAX_CONCURRENT; round++) {
      const batch = [];
      for (let i = 0; i < MAX_CONCURRENT; i++) {
        const res = await call("POST", "/api/v1/executions", q.keys[i % 2].key, FAST);
        if (res.status !== 202) fail(`execution ${accepted.length + 1} of ${DAILY_QUOTA} should be accepted, got ${res.status} ${JSON.stringify(res.body)}`);
        batch.push(res.body.id);
        accepted.push(res.body.id);
      }
      await waitUntilTerminal(batch);
      await letWindowSlide();
    }
    const overQuota = await call("POST", "/api/v1/executions", q.keys[1].key, FAST);
    expect429("execution over the daily quota", overQuota, "quota_exceeded");
    const toMidnight = Number(overQuota.headers.get("retry-after"));
    if (!(toMidnight >= 1 && toMidnight <= 86_400)) fail(`quota Retry-After should be until UTC midnight, got ${toMidnight}`);
    else ok(`quota: ${DAILY_QUOTA} accepted across both keys (a 400 cost nothing), the next is 429 until midnight UTC`);

    // --- a leaked slot heals itself ------------------------------------------------------
    // Simulate a worker that crashed without freeing its slots.
    const h = await account("heal");
    const now = Date.now();
    await redis.zadd(inflightKey(h.userId), now + 60_000, "exec_leakedLiveAAAAAAAAAAA", now + 60_000, "exec_leakedLiveBBBBBBBBBBB");
    expect429("slots held by live-looking leaks", await call("POST", "/api/v1/executions", h.keys[0].key, FAST), "concurrency_limited");
    await redis.del(inflightKey(h.userId));
    await redis.zadd(inflightKey(h.userId), now - 1000, "exec_leakedDeadAAAAAAAAAAA", now - 1000, "exec_leakedDeadBBBBBBBBBBB");
    const healed = await call("POST", "/api/v1/executions", h.keys[0].key, FAST);
    if (healed.status !== 202) fail(`expired leaked slots should be trimmed, got ${healed.status} ${JSON.stringify(healed.body)}`);
    else ok("a leaked slot blocks until its expiry, then is trimmed instead of locking the account out");
    await waitUntilTerminal([healed.body.id]);

    // --- throttled requests are attributed to the key that made them ---------------------
    await flushUsage();
    const usage = await call("GET", `/app/api-keys/${r.keys[1].id}/usage`, r.jwt);
    const today = usage.body?.days?.[usage.body.days.length - 1];
    if (today?.throttled !== 1) fail(`the second key's single 429 should be in its usage, got ${JSON.stringify(today)}`);
    else ok("usage: a throttled request is attributed to the key that made it");

    // --- nothing left holding a slot -------------------------------------------------------
    for (const acct of [c, q, h]) {
      const held = await redis.zcard(inflightKey(acct.userId));
      if (held !== 0) fail(`account ${acct.userId} still holds ${held} in-flight slots after everything finished`);
    }

    console.log(allPass ? "PASS" : "FAIL");
  } finally {
    await executors.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await redis.quit();
    await pool.end();
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
