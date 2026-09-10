/**
 * End-to-end for the public execution API, against a real API process, a
 * real worker pool and real Docker:
 *
 *   - key lifecycle under /app/api-keys: shown once, listed without the key,
 *     stored only as a SHA-256, active-key cap (including under concurrency),
 *     owner-scoped revoke
 *   - the auth boundary: no key / a session JWT / an unknown key are all 401
 *     on /api/v1, and an API key opens nothing under /app
 *   - validation and the error envelope: unknown fields, unknown language,
 *     oversized source, out-of-range limits, bad JSON, unknown route
 *   - every execution outcome: ok (C++ and Java), compile_error,
 *     runtime_error, timeout, out_of_memory under a caller-chosen limit, and
 *     truncated output
 *   - executions are scoped to the account (another account gets 404; the
 *     same account's other key can read them), and a revoked key is refused
 *
 * Requires Postgres + Redis + Docker running, and JWT_SECRET set (the npm
 * script sets it, plus MAX_ACTIVE_API_KEYS=2 so the cap is cheap to hit).
 */
import { createHash } from "crypto";
import { runMigrations, pool, executionQueue } from "@vj/infra";
import { WorkerPool, processOneExecution } from "@vj/worker";
import { startApiServer } from "@vj/api";

const PORT = 3098;
const ROOT = `http://localhost:${PORT}`;
const KEY_CAP = Number(process.env.MAX_ACTIVE_API_KEYS);

interface Res {
  status: number;
  headers: Headers;
  body: any;
}

async function call(
  method: string,
  path: string,
  opts: { bearer?: string; body?: unknown; rawBody?: string } = {}
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined || opts.rawBody !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${ROOT}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let allPass = true;
  const fail = (msg: string) => {
    console.log(`FAIL: ${msg}`);
    allPass = false;
  };
  /** Asserts the uniform error envelope with a specific status + code. */
  const expectError = (label: string, r: Res, status: number, code: string) => {
    if (r.status !== status || r.body?.error?.code !== code || typeof r.body?.error?.message !== "string") {
      fail(`${label}: expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)}`);
    }
  };

  if (!Number.isInteger(KEY_CAP) || KEY_CAP < 2) {
    throw new Error("run via `npm run test:public-api` (needs MAX_ACTIVE_API_KEYS=2)");
  }

  await runMigrations();
  const server = await startApiServer(PORT);
  console.log(`api-gateway listening on :${PORT}`);

  const executors = new WorkerPool({
    count: 3,
    waitMs: 1000,
    name: "test-executor",
    processOne: processOneExecution,
    onResult: (o, consumer) =>
      console.log(`[${consumer}] ${o.executionId} -> ${o.status} ${o.result?.outcome ?? ""}`),
  });
  executors.start();

  try {
    // --- two accounts -------------------------------------------------------
    const stamp = Date.now();
    const signupA = await call("POST", "/app/auth/signup", {
      body: { email: `api-a-${stamp}@example.com`, password: "test-password-123" },
    });
    const signupB = await call("POST", "/app/auth/signup", {
      body: { email: `api-b-${stamp}@example.com`, password: "test-password-123" },
    });
    const jwtA: string = signupA.body.token;
    const jwtB: string = signupB.body.token;
    if (!jwtA || !jwtB) throw new Error("signup failed");

    // --- key management (session auth) ---------------------------------------
    const anonCreate = await call("POST", "/app/api-keys", { body: { name: "x" } });
    if (anonCreate.status !== 401) fail(`creating a key without a session should be 401, got ${anonCreate.status}`);

    const noName = await call("POST", "/app/api-keys", { bearer: jwtA, body: {} });
    if (noName.status !== 400) fail(`creating a key without a name should be 400, got ${noName.status}`);

    const created1 = await call("POST", "/app/api-keys", { bearer: jwtA, body: { name: "primary" } });
    if (created1.status !== 201) fail(`POST /app/api-keys returned ${created1.status}`);
    const key1: string = created1.body.key;
    if (!/^vj_live_[0-9A-Za-z]{43}$/.test(key1)) fail(`key has the wrong format: ${key1}`);
    if (created1.body.key_prefix !== key1.slice(0, 16))
      fail(`key_prefix should be vj_live_ + 8 random chars, got ${created1.body.key_prefix}`);

    // Stored only as its SHA-256.
    const sha = createHash("sha256").update(key1).digest("hex");
    const stored = await pool.query("SELECT key_hash, key_prefix FROM api_keys WHERE id = $1", [
      created1.body.id,
    ]);
    if (stored.rows[0]?.key_hash !== sha) fail("api_keys.key_hash is not the SHA-256 of the key");
    if (JSON.stringify(stored.rows[0]).includes(key1)) fail("the raw key was stored");

    const listed = await call("GET", "/app/api-keys", { bearer: jwtA });
    if (listed.status !== 200 || listed.body.length !== 1) fail(`expected 1 listed key, got ${JSON.stringify(listed.body)}`);
    if (JSON.stringify(listed.body).includes(key1)) fail("GET /app/api-keys leaked the full key");
    if ("key" in listed.body[0] || "key_hash" in listed.body[0]) fail("list exposes key or key_hash");

    // Cap: KEY_CAP active keys, then 409. Revoked keys don't count toward it.
    const created2 = await call("POST", "/app/api-keys", { bearer: jwtA, body: { name: "second" } });
    if (created2.status !== 201) fail(`second key should be created, got ${created2.status}`);
    const overCap = await call("POST", "/app/api-keys", { bearer: jwtA, body: { name: "third" } });
    if (overCap.status !== 409) fail(`key over the cap should be 409, got ${overCap.status}`);

    const otherRevoke = await call("DELETE", `/app/api-keys/${created2.body.id}`, { bearer: jwtB });
    if (otherRevoke.status !== 404) fail(`revoking someone else's key should be 404, got ${otherRevoke.status}`);
    const revoke2 = await call("DELETE", `/app/api-keys/${created2.body.id}`, { bearer: jwtA });
    if (revoke2.status !== 204) fail(`revoke returned ${revoke2.status}`);
    const revokeAgain = await call("DELETE", `/app/api-keys/${created2.body.id}`, { bearer: jwtA });
    if (revokeAgain.status !== 204) fail(`revoke should be idempotent, got ${revokeAgain.status}`);

    const created3 = await call("POST", "/app/api-keys", { bearer: jwtA, body: { name: "after-revoke" } });
    if (created3.status !== 201) fail(`a revoked key should free a slot, got ${created3.status}`);
    const key3: string = created3.body.key;

    // The cap holds under concurrency: account B fires 6 creates at once.
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call("POST", "/app/api-keys", { bearer: jwtB, body: { name: `burst-${i}` } })
      )
    );
    const burstCreated = burst.filter((r) => r.status === 201).length;
    if (burstCreated !== KEY_CAP)
      fail(`concurrent creates should stop at the cap (${KEY_CAP}), created ${burstCreated}`);
    const keyB: string = burst.find((r) => r.status === 201)!.body.key;

    // --- the auth boundary ---------------------------------------------------
    expectError("no key", await call("GET", "/api/v1/languages"), 401, "unauthorized");
    expectError("session JWT on /api/v1", await call("GET", "/api/v1/languages", { bearer: jwtA }), 401, "unauthorized");
    expectError(
      "well-formed but unknown key",
      await call("GET", "/api/v1/languages", { bearer: `vj_live_${"A".repeat(43)}` }),
      401,
      "unauthorized"
    );
    for (const path of ["/app/profile", "/app/api-keys", "/app/auth/me"]) {
      const r = await call("GET", path, { bearer: key1 });
      if (r.status !== 401) fail(`an API key must not open ${path}, got ${r.status}`);
    }

    // --- languages -------------------------------------------------------------
    const langs = await call("GET", "/api/v1/languages", { bearer: key1 });
    if (langs.status !== 200) fail(`GET /api/v1/languages returned ${langs.status}`);
    const ids = (langs.body?.data ?? []).map((l: any) => l.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(["cpp", "java", "python"])) fail(`languages: ${JSON.stringify(ids)}`);
    if (JSON.stringify(langs.body).includes("judge-")) fail("languages leaks sandbox image names");

    // --- validation + the error envelope -----------------------------------------
    const exec = (body: unknown, bearer = key1) => call("POST", "/api/v1/executions", { bearer, body });

    const unknownField = await exec({ language: "python", source_code: "print(1)", callback_url: "https://x" });
    expectError("unknown field", unknownField, 400, "invalid_request");
    if (!String(unknownField.body?.error?.message).includes("callback_url"))
      fail(`unknown-field message should name the field: ${unknownField.body?.error?.message}`);
    expectError("unknown language", await exec({ language: "rust", source_code: "fn main(){}" }), 400, "invalid_language");
    expectError("missing source", await exec({ language: "python" }), 400, "invalid_request");
    expectError(
      "oversized source",
      await exec({ language: "python", source_code: "#".repeat(70 * 1024) }),
      413,
      "source_too_large"
    );
    const tooLong = await exec({ language: "python", source_code: "print(1)", limits: { time_ms: 60000 } });
    expectError("time_ms over the max", tooLong, 400, "invalid_request");
    if (!/between/.test(String(tooLong.body?.error?.message))) fail("out-of-range message should state the range");
    expectError(
      "memory_mb under the min",
      await exec({ language: "python", source_code: "print(1)", limits: { memory_mb: 8 } }),
      400,
      "invalid_request"
    );
    expectError(
      "malformed JSON",
      await call("POST", "/api/v1/executions", { bearer: key1, rawBody: "{not json" }),
      400,
      "invalid_request"
    );
    expectError("unknown route", await call("GET", "/api/v1/nope", { bearer: key1 }), 404, "not_found");
    expectError(
      "malformed execution id",
      await call("GET", "/api/v1/executions/exec_tooshort", { bearer: key1 }),
      404,
      "not_found"
    );

    // --- executions: one per outcome, all queued at once -------------------------
    const CASES: {
      name: string;
      body: Record<string, unknown>;
      check: (e: any) => string | null;
    }[] = [
      {
        name: "C++ ok",
        body: {
          language: "cpp",
          source_code: `#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`,
          stdin: "3 4\n",
        },
        check: (e) =>
          e.result.outcome === "ok" && e.result.stdout === "7\n" && e.result.exit_code === 0 &&
          e.limits.time_ms === 5000 && e.limits.memory_mb === 256 && typeof e.result.wall_time_ms === "number"
            ? null
            : "expected ok, stdout 7, exit 0, default limits echoed",
      },
      {
        name: "Java ok",
        body: {
          language: "java",
          source_code:
            "import java.util.Scanner;\npublic class Main { public static void main(String[] a) { Scanner s = new Scanner(System.in); System.out.println(s.nextInt() * s.nextInt()); } }",
          stdin: "6 7",
        },
        check: (e) => (e.result.outcome === "ok" && e.result.stdout.trim() === "42" ? null : "expected ok, stdout 42"),
      },
      {
        name: "compile error",
        body: { language: "cpp", source_code: "int main() { return undefined_symbol; }" },
        check: (e) =>
          e.result.outcome === "compile_error" && e.result.compile_output.includes("undefined_symbol") &&
          e.result.wall_time_ms === null && e.result.exit_code === null
            ? null
            : "expected compile_error with compiler output and no run",
      },
      {
        name: "runtime error",
        body: { language: "python", source_code: "import sys\nprint('boom', file=sys.stderr)\nsys.exit(3)" },
        check: (e) =>
          e.result.outcome === "runtime_error" && e.result.exit_code === 3 && e.result.stderr.includes("boom")
            ? null
            : "expected runtime_error, exit 3, stderr boom",
      },
      {
        name: "timeout under a 1s limit",
        body: { language: "python", source_code: "import time\ntime.sleep(30)", limits: { time_ms: 1000 } },
        check: (e) =>
          e.result.outcome === "timeout" && e.result.exit_code === null && e.limits.time_ms === 1000
            ? null
            : "expected timeout with the 1000ms limit echoed",
      },
      {
        name: "out of memory under a 64 MB limit",
        body: {
          language: "python",
          source_code: `x = b"a" * (100 * 1024 * 1024)\nprint(len(x))`,
          limits: { memory_mb: 64 },
        },
        check: (e) =>
          e.result.outcome === "out_of_memory" && e.limits.memory_mb === 64 ? null : "expected out_of_memory at 64 MB",
      },
      {
        name: "output truncated",
        body: { language: "python", source_code: `import sys\nsys.stdout.write("x" * (3 * 1024 * 1024))` },
        check: (e) =>
          e.result.outcome === "ok" && e.result.output_truncated === true && e.result.stdout.length === 1024 * 1024
            ? null
            : "expected ok with stdout cut to 1 MiB and output_truncated",
      },
    ];

    const queued = await Promise.all(CASES.map((c) => exec(c.body)));
    const ids202: string[] = [];
    queued.forEach((r, i) => {
      if (r.status !== 202) fail(`${CASES[i].name}: POST returned ${r.status} ${JSON.stringify(r.body)}`);
      if (r.body?.status !== "queued") fail(`${CASES[i].name}: 202 body should say queued`);
      if (!/^exec_[0-9A-Za-z]{22}$/.test(r.body?.id)) fail(`${CASES[i].name}: bad id ${r.body?.id}`);
      if (r.headers.get("location") !== `/api/v1/executions/${r.body?.id}`)
        fail(`${CASES[i].name}: Location header ${r.headers.get("location")}`);
      ids202.push(r.body?.id);
    });

    // Poll until every execution is terminal.
    const finals: any[] = new Array(CASES.length).fill(null);
    const deadline = Date.now() + 90_000;
    while (finals.some((f) => f === null) && Date.now() < deadline) {
      await Promise.all(
        ids202.map(async (id, i) => {
          if (finals[i]) return;
          const r = await call("GET", `/api/v1/executions/${id}`, { bearer: key1 });
          if (r.status !== 200) {
            fail(`GET ${id} returned ${r.status}`);
            finals[i] = { status: "error" };
            return;
          }
          if (r.body.status !== "completed" && r.body.result !== null)
            fail(`${CASES[i].name}: result must be null until completed`);
          if (r.body.status === "completed" || r.body.status === "failed") finals[i] = r.body;
        })
      );
      if (finals.some((f) => f === null)) await sleep(300);
    }

    finals.forEach((f, i) => {
      if (!f) return fail(`${CASES[i].name}: never finished`);
      if (f.status !== "completed") return fail(`${CASES[i].name}: status ${f.status}`);
      if ("source_code" in f || "stdin" in f || "user_id" in f) fail(`${CASES[i].name}: response leaks input/owner`);
      const problem = CASES[i].check(f);
      if (problem) fail(`${CASES[i].name}: ${problem} — got ${JSON.stringify({ ...f.result, stdout: f.result.stdout.slice(0, 80) })}`);
      else console.log(`ok: ${CASES[i].name}`);
    });

    // --- scoping ---------------------------------------------------------------
    const firstId = ids202[0];
    expectError(
      "another account reading an execution",
      await call("GET", `/api/v1/executions/${firstId}`, { bearer: keyB }),
      404,
      "not_found"
    );
    const sameAccount = await call("GET", `/api/v1/executions/${firstId}`, { bearer: key3 });
    if (sameAccount.status !== 200) fail(`the same account's other key should read it, got ${sameAccount.status}`);

    // --- usage is recorded on the key (off the request path) ---------------------
    const afterUse = await call("GET", "/app/api-keys", { bearer: jwtA });
    const used = afterUse.body.find((k: any) => k.id === created1.body.id);
    if (!used?.last_used_at) fail("last_used_at was not recorded for the key");

    // --- revocation -------------------------------------------------------------
    await call("DELETE", `/app/api-keys/${created1.body.id}`, { bearer: jwtA });
    expectError(
      "revoked key",
      await call("GET", `/api/v1/executions/${firstId}`, { bearer: key1 }),
      401,
      "key_revoked"
    );

    // --- nothing left pending on the executions stream ---------------------------
    let pending = -1;
    for (let i = 0; i < 20 && pending !== 0; i++) {
      pending = await executionQueue.pendingCount();
      if (pending !== 0) await sleep(250);
    }
    if (pending !== 0) fail(`${pending} executions left unacked`);

    console.log(allPass ? "PASS" : "FAIL");
  } finally {
    await executors.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
