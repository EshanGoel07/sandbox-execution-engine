# Spec — Public Execution API (v1)

Status: specified, not yet implemented.
Owner: Phase 6 of PLAN.md.

---

## 1. Why this exists

The valuable thing in this repo is the **execution engine**: container-per-run isolation,
cgroup-enforced memory and PID limits, no network, non-root, OOM detection, wall-clock
timeouts, and an async grading pipeline. The website is one consumer of that engine.

Exposing the engine as a documented, key-authenticated HTTP API makes that relationship
explicit: this is code-execution infrastructure with a judge built on top of it, not a
website that happens to run code.

## 2. The architectural line: execution vs grading

Two different concepts, deliberately kept on different endpoints:

| Concept | Endpoint | Input | Output |
|---|---|---|---|
| **Execution** | `POST /api/v1/executions` | language, source, stdin, limits | stdout, stderr, exit code, cpu/mem/time |
| **Grading** | `POST /app/submissions` | problemId, language, source | verdict, per-test results |

Execution knows nothing about problems, test cases, or verdicts. Grading is built *on top of*
execution: it fetches test cases, drives the engine once per case, compares output, and
aggregates a verdict. Keeping these separate is what makes the engine reusable.

The public API exposes **execution only**. Grading stays an application concern.

## 3. Process & routing layout

One Express process, two route trees, two authentication strategies:

```
apps/api/
├─ src/
│  ├─ http/
│  │  ├─ app.ts                # composes both route trees
│  │  ├─ public/               # /api/v1/*  — API-key auth
│  │  │  ├─ executions.routes.ts
│  │  │  ├─ languages.routes.ts
│  │  │  └─ keys.routes.ts     # (key management is session-auth, see below)
│  │  └─ web/                  # /app/*     — session-cookie auth
│  │     ├─ auth.routes.ts
│  │     ├─ problems.routes.ts
│  │     ├─ submissions.routes.ts
│  │     └─ admin.routes.ts
│  ├─ auth/
│  │  ├─ session.middleware.ts
│  │  ├─ apiKey.middleware.ts
│  │  └─ rateLimit.middleware.ts
│  └─ ...
```

**Decision:** one process, not two services. Two deployments would double the ops surface for
no benefit at this scale; the separation that matters is the *route tree and auth boundary*,
and that is enforced in code. Documented here so it reads as a choice, not an oversight.

## 4. Endpoints

### `POST /api/v1/executions`
Submit code for one-off execution.

```jsonc
// request
{
  "language": "cpp",           // see GET /api/v1/languages
  "source_code": "...",
  "stdin": "1 2\n",            // optional, default ""
  "limits": {                  // optional; clamped to plan maximums
    "time_ms": 5000,
    "memory_mb": 256
  },
  "callback_url": "https://..." // optional webhook, see §7
}
```

```jsonc
// 202 Accepted
{ "id": "exec_9f3c...", "status": "queued", "created_at": "..." }
```

Add `?wait=true` to block until finished (server-side cap of 10s, then falls back to
returning the queued response). Default is async — the whole point of the queue is that the
request thread does not wait on execution.

### `GET /api/v1/executions/:id`
```jsonc
{
  "id": "exec_9f3c...",
  "status": "completed",        // queued | running | completed | failed
  "result": {
    "outcome": "ok",            // ok | compile_error | runtime_error | timeout | out_of_memory
    "exit_code": 0,
    "stdout": "3\n",
    "stderr": "",
    "compile_output": "",
    "wall_time_ms": 18,
    "cpu_time_ms": 11,
    "peak_memory_kb": 3072
  }
}
```

### `POST /api/v1/executions/batch`
Array of up to 20 execution requests; returns an array of ids. One queue push per item.

### `GET /api/v1/languages`
Supported languages with image tag and compiler/interpreter version, read from the language
config — never hardcoded in two places.

### Key management (session-auth, not key-auth)
- `POST   /app/api-keys`         → create, returns the full key **once**
- `GET    /app/api-keys`         → list (prefix + metadata only, never the key)
- `DELETE /app/api-keys/:id`     → revoke
- `GET    /app/api-keys/:id/usage` → usage series for the dashboard

## 5. API keys

```sql
api_keys(
  id, user_id, name,
  key_prefix TEXT NOT NULL,        -- first 8 chars, indexed, for lookup
  key_hash   TEXT NOT NULL,        -- sha256 of the full key
  tier TEXT NOT NULL DEFAULT 'free',
  created_at, last_used_at, revoked_at
)
```

- Format: `vj_live_<43 chars base62>` (256 bits of entropy).
- Shown in full exactly once, at creation. Never retrievable afterwards.
- Stored as **SHA-256, not bcrypt**. Deliberate: bcrypt exists to slow down brute force against
  *low-entropy human passwords*. An API key is 256 random bits — brute force is not the threat
  model, and bcrypt on every single request would add tens of milliseconds to an endpoint whose
  whole selling point is single-digit-ms latency. Documented because it is the opposite of the
  password rule and an interviewer will ask.
- Lookup: index on `key_prefix`, then constant-time compare of the hash.
- `revoked_at IS NOT NULL` → 401.

## 6. Rate limits, quotas, and fairness

Three distinct controls. They are not the same thing and each exists for a different reason.

| Control | Question it answers | Where | Mechanism |
|---|---|---|---|
| **Rate limit** | "too many requests per minute?" | Redis | sliding window: sorted set per key, `ZREMRANGEBYSCORE` + `ZCARD` |
| **Quota** | "used up the daily allowance?" | Redis + Postgres | `INCR quota:<keyId>:<YYYY-MM-DD>` with TTL; durable roll-up in Postgres |
| **Concurrency cap** | "one key hogging all the workers?" | Redis | `INCR inflight:<keyId>` on enqueue, `DECR` on completion; reject above cap |

The concurrency cap is the one that actually protects the system: without it, a single client
can fill the queue and starve every other user regardless of how polite their request *rate* is.

Response headers on every public endpoint:
```
X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
```
On rejection: `429` with `Retry-After`. On quota exhaustion: `429` with a distinct
`error.code = "quota_exceeded"` so clients can tell the two apart.

Tiers live in a `plans` config table (requests/min, executions/day, max concurrency,
max time_ms, max memory_mb) — not hardcoded constants.

## 7. Webhooks (optional, build only if time allows)

If `callback_url` is supplied, POST the completed execution to it. Requirements if built:
- HMAC-SHA256 signature over the raw body in an `X-VJ-Signature` header, secret per key
- Retries with exponential backoff (3 attempts), then give up and mark `callback_failed`
- 5s timeout per attempt; callbacks never block the worker (separate dispatch queue)
- Refuse private/loopback/link-local targets (SSRF protection)

## 8. Usage tracking

```sql
api_usage(id, api_key_id, endpoint, status_code, duration_ms, created_at)
```
Written asynchronously (never in the request's critical path). Powers the per-key usage chart
and feeds the admin dashboard's totals.

## 9. Errors

Uniform envelope, HTTP status plus a stable machine-readable code:
```jsonc
{ "error": { "code": "invalid_language", "message": "Unknown language 'rust'." } }
```
Codes: `unauthorized`, `key_revoked`, `rate_limited`, `quota_exceeded`, `concurrency_limited`,
`invalid_request`, `invalid_language`, `source_too_large`, `not_found`, `internal`.

## 10. Documentation deliverables

- `openapi.yaml` — OpenAPI 3.1 spec, hand-maintained, source of truth for the surface
- Swagger UI (or Scalar) served at `/api/docs` from that spec
- `packages/sdk-ts/` — a small typed client (`createExecution`, `getExecution`, `waitFor`)
- A quickstart in the README: create a key → curl example → SDK example

## 11. Security requirements

- Keys never logged, never in URLs (Authorization header only), never returned after creation
- Source-code size cap (e.g. 256 KB) enforced before enqueue
- Requested limits clamped to the plan maximum server-side — a client cannot ask for 8 GB
- Validation (zod) on every body; unknown fields rejected
- The public API never exposes problems, test cases, users, or any app data
- CORS: the public API allows cross-origin key-auth calls; the session-auth `/app/*` tree does not
