# Sandbox Execution Engine

A code execution engine that runs **untrusted source code inside a locked-down
Docker container** — memory and PID limits enforced by cgroups, no network, a
non-root user, and a wall-clock kill — and an asynchronous grading pipeline
built on top of it.

The engine has two consumers here, and they are kept apart on purpose:

- a **public execution API** (`/api/v1`) — API-key authenticated, metered per
  account, described by an OpenAPI spec, with a typed TypeScript SDK. It runs
  code and reports what happened; it knows nothing about problems or grading.
- an **online judge** — the reference client — which builds grading (test
  cases, verdicts) on top of the same engine behind its own session-auth API.
  Its web UI imports nothing but shared types and talks to the server only
  over HTTP.

Built to understand, end to end, how systems like Judge0 or the machinery behind
Codeforces actually work: OS-level isolation, a durable work queue, a worker
pool, pub/sub between processes, live result streaming, and a metered public
API in front of it all.

**Status:** the engine, the public API, the grading pipeline and the reference
client are complete and tested. Empirical complexity analysis is next — see
[Roadmap](#roadmap).

![Demo](docs/demo.gif)

> **There is no hosted demo, deliberately.** Executing arbitrary code from the
> internet needs a dedicated, isolated Docker host — it is not something to put
> on shared free hosting. The whole stack runs locally with one command; see
> [Run it locally](#run-it-locally).

---

## What it does

**The engine** takes a language, source code, stdin and resource limits, and
returns stdout, stderr, exit code and timing — nothing more. It knows nothing
about problems, test cases or verdicts.

- One throwaway Docker container per run: `256 MB` memory cgroup, `64` PID cap,
  `NetworkMode: none`, non-root `coderunner` user.
- C++ (`gcc:13`), Java (`eclipse-temurin:21-jdk`), Python (`python:3.12-alpine`).
- Distinguishes the ways a program can fail: OOM kill (read from the kernel's
  cgroup `oom_kill` counter, not guessed from the exit code), wall-clock
  timeout, non-zero exit, and compile failure (itself under a wall-clock cap).

**The public API** exposes the engine directly — see
[Public execution API](#public-execution-api) for the quickstart.

- `POST /api/v1/executions` queues a run and returns `202` with an id in
  single-digit milliseconds; `GET /api/v1/executions/:id` reports `queued →
  running → completed` and the result. No server-side waiting.
- Per-account sliding-window rate limit, daily quota, and in-flight
  concurrency cap, all atomic in Redis; `X-RateLimit-*` on every response.
- Caller-chosen time and memory limits, validated (never silently clamped).
  Output is capped at 1 MiB per stream and flagged when truncated.

**The grading pipeline** turns execution into verdicts.

- A submission is one `INSERT` plus one `XADD` — the HTTP request never waits
  for judging.
- Redis Streams consumer groups deliver work to a pool of concurrent workers,
  each on its own connection. Unacknowledged messages survive a worker crash.
- Compile once, then run each test case against the compiled artifact, stopping
  at the first failure.
- Verdicts: `Accepted`, `Wrong Answer`, `Compile Error`, `Runtime Error`,
  `Time Limit Exceeded`, `Memory Limit Exceeded`, `Internal Error`.
- Status changes reach the browser live over WebSockets, fed by Redis Pub/Sub.

**The reference client** is a React + Monaco SPA: a split-pane problem page,
live `Queued → Judging → verdict` transitions with a per-test breakdown, and a
profile with solved count, acceptance rate and submission history.

## Architecture

```
                                  ┌──────────────────────────────┐
  Browser (React + Monaco)        │        API gateway           │
     │  POST /app/auth/login ────▶│  (Express)                   │
     │  ◀──── JWT ────────────────┤   bcrypt verify, sign JWT    │
     │                            │                              │
     │  POST /app/submissions ───▶│   requireAuth (Bearer JWT)   │
     │   (Authorization: Bearer)  │   1. INSERT submission (PG)  │
     │                            │   2. XADD submissionId ──────┼──▶ Redis Stream
     │  WebSocket /ws  ◀──────────┤   3. WS hub (1 subscriber)   │      "submissions"
     │   subscribe(submissionId)  └───────────▲──────────────────┘         │
     │                                        │ Redis Pub/Sub              │ XREADGROUP
     │   Queued → Judging → Accepted          │ "submission-updates"       │ (consumer group)
     ▼                                        │                            ▼
  live status + per-test results     ┌────────┴───────────────────────────────────┐
                                     │              Worker pool                    │
                                     │  N consumers, one Redis conn each           │
                                     │   • fetch submission + test cases from PG   │
                                     │   • publish "Judging"                       │
                                     │   • grade: compile once in a Docker         │
                                     │     sandbox, exec once per test case,       │
                                     │     stop at first non-Accepted              │
                                     │   • persist results, publish "Done"         │
                                     │   • XACK                                    │
                                     └────────────────────────────────────────────┘
                                          Postgres  ◀── source of truth
```

The public API is a second route tree in the **same** API process, feeding a
**separate** stream and worker pool:

```
  API client (curl / SDK)            ┌─────────────────────────────────┐
     │  POST /api/v1/executions ────▶│  /api/v1  (API-key auth)        │
     │   Authorization: Bearer       │  1. SHA-256(key) → indexed      │
     │   vj_live_...                 │     lookup, revoked? → 401      │
     │                               │  2. rate limit        (Redis)   │
     │  ◀──── 202 { id } ────────────┤  3. quota + slot  (1 atomic op) │
     │                               │  4. INSERT execution (PG)       │
     │  GET /api/v1/executions/:id   │  5. XADD executionId ───────────┼──▶ Redis Stream
     │   (poll — the SDK's waitFor)  └─────────────────────────────────┘     "executions"
     ▼                                                                          │
  queued → running → completed        ┌─────────────────────────────────────────▼──┐
                                      │  Execution pool (its own consumers)         │
                                      │   • runOnce in a sandbox, caller's limits   │
                                      │   • save result, free the in-flight slot    │
                                      │   • XACK                                    │
                                      └─────────────────────────────────────────────┘
```

**Why it's shaped this way:**

| Decision | Reason |
|---|---|
| Namespaces + cgroups via Docker | Namespaces limit what the process can *see* (no network, own PID space); cgroups limit what it can *consume* (256 MB RAM, 64 PIDs). Docker packages both plus the language image. |
| App-level wall-clock timeout *on top of* cgroups | cgroups cap CPU-time consumed, not time elapsed. A `sleep(3600)` submission burns ~0% CPU but still has to be killed. |
| Redis **Stream + consumer group** (not a plain list) | If a worker dies mid-job the message stays pending and unacked instead of vanishing — nothing is silently lost. |
| Queue payload is **just a `submissionId`** | Postgres is the source of truth, so a worker always grades current DB state, and the queue stays cheap regardless of submission size. |
| One Redis connection **per worker consumer** | ioredis serializes commands per connection; a blocking `XREADGROUP` on a shared connection would stall every other consumer. |
| **Compile once, run many** | One persistent sandbox container per submission (`sleep infinity` + `exec`), compiled once, then one `exec` per test case — not N containers / N recompiles. |
| **Stop at first failing test** | Matches real judges and saves compute. |
| OOM read from the **kernel's cgroup counter**, not Docker's flag | Docker's `OOMKilled` is set asynchronously from an event stream — measured, 11 of 12 OOM kills still read `false` right after the program died — and stays set for the container's lifetime. The cgroup v2 `oom_kill` counter is incremented as part of the kill, and comparing it per run attributes each kill to the run that caused it. |
| Worker → API over **Redis Pub/Sub** (separate processes) | The worker and the API scale and fail independently. They don't call each other; they exchange `{submissionId, status}` messages. |
| **One** Redis subscriber for the whole API, fanned out in-process | A `SUBSCRIBE` puts a connection in subscriber-only mode. One subscriber → a `Map<submissionId, Set<socket>>` is all that's needed; the update only has to reach the process once. |
| **Snapshot + subscribe** on WS connect | A client can subscribe *after* the worker already finished, and would hang forever. On subscribe, the hub registers for live pushes *and* sends a DB-backed status snapshot. |
| `GET /app/problems/:id` omits `expected_output` | A real judge doesn't hand clients the answer key. |
| **JWT, not server sessions** | The client is a separate origin from the API, which makes cookie auth awkward without collapsing them behind one host. A bearer token carries only the user id; everything else is a Postgres lookup. The trade-off is real and documented under [Known limitations](#known-limitations). |
| Auth is **independent of the sandbox** | `DEMO_MODE` skips only the enqueue step, so the API, auth and WebSocket paths can be exercised on a host that cannot safely execute code. |
| **Engine/client boundary enforced in code** | `apps/web` may import `packages/shared` and nothing else; `apps/api` may not import the execution engine. `npm run lint` fails the build on a violation, so the separation cannot rot quietly. |
| **A worker never throws a message into limbo** | An unprocessable job (unknown language, say) is marked `Internal Error`, published, and `XACK`ed. Without that, a poison message stays unacknowledged forever and freezes the submission in `Judging`. Genuinely transient failures still rethrow, so the message stays pending and redelivers. |
| **Execution and grading on different endpoints** | `/api/v1` runs code and reports what happened; it has no problems, test cases or verdicts. Grading lives in the judge's `/app` tree and is built *on* execution. Keeping them apart is what makes the engine reusable. |
| **Two route trees, two auth strategies, one process** | `/app/*` takes a session JWT, `/api/v1/*` takes an API key; each tree is its own router with its own auth, body parser and error shape, and neither credential opens the other. A second service would double the ops surface for no benefit at this scale; the boundary that matters is enforced in code. |
| API keys hashed with **SHA-256, not bcrypt** | bcrypt's slowness defends *low-entropy* passwords against offline guessing. A key is 256 random bits — there is nothing to guess — so bcrypt would buy no security and add ~250 ms to every request. An unsalted hash is also deterministic, so auth is one indexed lookup rather than prefix-then-compare. |
| Limits are **per account, not per key** | Keys are free to mint; a per-key quota could be multiplied just by minting more keys. The account is metered and keys are interchangeable credentials — while usage is still *attributed* per key, so "which key is making these calls?" stays answerable. |
| A **concurrency cap**, not just a rate limit | A client can be polite about request *rate* and still queue hundreds of slow executions, starving everyone else. Capping what is in flight per account bounds how much of the queue one account can hold. |
| In-flight tracked as a **sorted set with expiries**, not `INCR`/`DECR` | A counter leaks when a worker crashes between the increment and the decrement, and enough leaks lock an account out for good. Here each slot is an execution id with an expiry: the worker removes it when done, and anything expired is trimmed before counting — leaks heal themselves. |
| Limit checks are **Lua scripts** timed by **Redis's clock** | Check-then-increment as two commands lets two concurrent requests both see "one left". A script is atomic, and using Redis `TIME` means several API processes agree on one window regardless of their own clocks. |
| **Separate stream and consumers** for executions | A bulkhead: a flood of API executions backs up its own queue but can't delay a single grading job, and vice versa. |
| **No server-side wait** | The API answers `202` in milliseconds and the client polls (the SDK's `waitFor` does it with backoff). Holding requests open until code finishes would tie API latency to program runtime — the coupling the whole queue exists to break. |
| `openapi.yaml` is the **source of truth, enforced** | The SDK's types are generated from it (`npm run lint` fails if they're stale), and the integration tests validate every live `/api/v1` response against it with `additionalProperties: false` — so a leaked field fails the build as surely as a missing one. |
| Usage written **off the request path, in batches** | The request only appends to an in-memory buffer; one `INSERT` per second flushes it. Usage is analytics, not billing, so losing up to a second of rows on a crash is an accepted trade — enforcement never reads this table. |

## Public execution API

Interactive docs: **http://localhost:3000/api/docs** (Swagger UI over
[`openapi.yaml`](openapi.yaml)). Everything below assumes the stack is running
([Run it locally](#run-it-locally)) and uses [`jq`](https://jqlang.org).

### Quickstart — curl

API keys are created by an account holder with a session token, never with
another key. So: get a session, mint a key, then use the key.

```bash
API=http://localhost:3000

# 1. An account and a session token. (Signup is rate-limited per IP; if the
#    account already exists, skip straight to login.)
curl -s -X POST $API/app/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-password"}' > /dev/null
TOKEN=$(curl -s -X POST $API/app/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-password"}' | jq -r .token)

# 2. An API key. The full key is in this response and nowhere else, ever —
#    only its SHA-256 is stored.
KEY=$(curl -s -X POST $API/app/api-keys -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"quickstart"}' | jq -r .key)

# 3. Run code. The POST answers 202 immediately; poll the execution.
ID=$(curl -s -X POST $API/api/v1/executions -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"language":"python","source_code":"a, b = map(int, input().split())\nprint(a + b)","stdin":"3 4\n"}' \
  | jq -r .id)
sleep 2
curl -s $API/api/v1/executions/$ID -H "Authorization: Bearer $KEY" | jq
```

```jsonc
{
  "id": "exec_nA3kGoCFLrGGFX0uJjet0X",
  "status": "completed",                 // queued | running | completed | failed
  "language": "python",
  "limits": { "time_ms": 5000, "memory_mb": 256 },
  "result": {
    "outcome": "ok",                     // ok | compile_error | runtime_error | timeout | out_of_memory
    "exit_code": 0,
    "stdout": "7\n",
    "stderr": "",
    "compile_output": "",
    "output_truncated": false,
    "wall_time_ms": 32
  },
  // ...plus created_at / started_at / completed_at
}
```

`failed` means the service couldn't run it. A program that ran and crashed is
`completed` with a non-`ok` outcome.

### Quickstart — TypeScript SDK

[`packages/sdk-ts`](packages/sdk-ts) is a typed client with no runtime
dependencies. Its types are generated from `openapi.yaml`. It isn't published
to npm; use it from this workspace.

```ts
import { VirtualJudge } from "@vj/sdk";

const vj = new VirtualJudge({ apiKey: process.env.VJ_API_KEY!, baseUrl: "http://localhost:3000" });

// createExecution + waitFor (client-side polling with backoff; honours Retry-After)
const execution = await vj.run({
  language: "python",
  source_code: "a, b = map(int, input().split())\nprint(a + b)",
  stdin: "3 4\n",
  limits: { time_ms: 2000, memory_mb: 128 },
});
console.log(execution.result?.stdout); // "7\n"
```

Runnable as-is: `npm run build && VJ_API_KEY=$KEY npm run example -w @vj/sdk`.
Also exposed: `createExecution`, `getExecution`, `waitFor`, `listLanguages`,
and `VirtualJudgeError` (`status`, `code`, `retryAfterSeconds`).

### Endpoints

| Endpoint | Auth | |
|---|---|---|
| `POST /api/v1/executions` | API key | queue a run → `202 { id, status: "queued" }` + `Location` |
| `GET /api/v1/executions/:id` | API key | status + result; any key of the owning account can read it |
| `GET /api/v1/languages` | API key | id, name, version, and notes (e.g. Java's class must be `Main`) |
| `POST /app/api-keys` | session | create a key — shown once |
| `GET /app/api-keys` | session | list keys (prefix + metadata, never the key) |
| `DELETE /app/api-keys/:id` | session | revoke (takes effect on the next request) |
| `GET /app/api-keys/:id/usage` | session | daily requests / executions / throttled / errors for one key |

### Limits

Per **account**, shared by all its keys. Defaults, all env-configurable:

| Control | Default | On breach |
|---|---|---|
| Requests (sliding window, every endpoint) | 120 / 60 s | `429 rate_limited` + `Retry-After` |
| Executions accepted per UTC day | 1000 | `429 quota_exceeded` + `Retry-After` (to midnight UTC) |
| Executions queued or running at once | 3 | `429 concurrency_limited` + `Retry-After` |
| Active API keys | 5 | `409` on create |
| Per execution: `time_ms` / `memory_mb` | 100–5000 / 32–256, default the max | `400 invalid_request` (never silently clamped) |
| `source_code` / `stdin` | 64 KiB each | `413 source_too_large` / `400 invalid_request` |
| stdout / stderr captured | 1 MiB each | cut off, `output_truncated: true` |

Every authenticated response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`
and `X-RateLimit-Reset` (Unix seconds when the oldest counted request leaves
the window).

### Errors

Every error is `{ "error": { "code": "...", "message": "..." } }`. Switch on
`code` — it's stable; `message` is for humans.

`unauthorized` · `key_revoked` · `rate_limited` · `quota_exceeded` ·
`concurrency_limited` · `invalid_request` · `invalid_language` ·
`source_too_large` · `not_found` · `execution_disabled` · `internal`

Unknown fields in a request body are rejected (`invalid_request`), so a typo —
or a field this API doesn't support, like a webhook URL — is reported rather
than silently ignored. Another account's execution is `404`, not `403`, so an
id's existence is never confirmed.

## Accounts & auth

- `POST /app/auth/signup` / `POST /app/auth/login` -> `{ token, user }`. Passwords are
  hashed with bcrypt at cost 12; the JWT (7-day expiry, HS256, algorithm pinned
  on verify) carries only `sub: userId`. `JWT_SECRET` has no fallback anywhere —
  the API refuses to start without it.
- API keys (`vj_live_` + 43 base62 characters, 256 bits) are stored only as a
  SHA-256 hash, sent only in the `Authorization` header, never logged, and
  checked on every request, so revocation is immediate. A session token is
  refused by `/api/v1`, and an API key is refused by `/app`.
- Every submission route is scoped to its owner. `GET /app/submissions/:id` returns
  `404` for someone else's id rather than `403`, so it does not confirm the id
  exists, and the response omits `source_code`, `user_id` and `stdin`.
- The WebSocket hub is scoped the same way: a subscribe with no session, a bad
  token, or another user's submission id is rejected.
- Rate limited: signup, login and submission creation, all env-tunable.
- Login always runs a bcrypt comparison, against a dummy hash when the account
  does not exist, so response timing does not reveal which emails are registered.

## Tech stack

- **Language:** TypeScript everywhere (shared types, engine, infra, API, worker, web)
- **Sandbox:** Docker via `dockerode` — `gcc:13`, `eclipse-temurin:21-jdk`,
  `python:3.12-alpine` images, each running as a non-root user
- **Queue:** Redis Streams + consumer groups (`ioredis`)
- **Real-time:** Redis Pub/Sub → `ws` WebSocket gateway
- **DB:** PostgreSQL (`pg`)
- **API:** Express, `zod` (strict schemas on the public API)
- **Auth:** `bcryptjs` (cost 12) + `jsonwebtoken` (JWT, HS256) + `express-rate-limit`;
  API keys hashed with SHA-256 (`node:crypto`)
- **Public API limits:** Redis sorted sets + Lua scripts
- **API docs & SDK:** OpenAPI 3.1 (`openapi.yaml`), Swagger UI (`swagger-ui-dist`,
  self-hosted), `openapi-typescript` for the SDK's types, `ajv` for contract tests
- **Frontend:** React + Vite + `@monaco-editor/react` + React Router
- **Load testing:** k6

## Run it locally

**Full real stack (actual code execution) — one command:**

```bash
git clone https://github.com/EshanGoel07/sandbox-execution-engine.git
cd sandbox-execution-engine
cp .env.example .env          # then set JWT_SECRET (openssl rand -hex 32)
docker compose up --build
```

- Frontend → http://localhost:8080
- API → http://localhost:3000 — docs at http://localhost:3000/api/docs
- Adminer (DB browser) → http://localhost:8081

The first boot builds the three language sandbox images (~1–2 min). The
`worker` service mounts the host Docker socket so it can build those
images and spawn one throwaway sandbox per submission. Migrations and a few
sample problems are applied automatically on API start.

**Backend only, without Docker Compose** (Node 22+, a local Docker daemon):

```bash
docker run -d --name judge-postgres -p 5432:5432 -e POSTGRES_PASSWORD=judge -e POSTGRES_DB=judge postgres:16-alpine
docker run -d --name judge-redis -p 6379:6379 redis:7-alpine

npm install                                                  # root — installs every workspace
for l in cpp java python; do docker build -t judge-$l apps/worker/images/$l; done
npm run seed                                                 # runs migrations + seeds problems
JWT_SECRET=dev-secret npm run api        # terminal 1
npm run worker                           # terminal 2
```

## Load test

Two k6 scripts against the **real** (non-demo) local stack, one per route
tree. Both ramp to 20 virtual users over 80 s and drive the whole path —
API → Redis Stream → worker → Docker sandbox → Postgres. The rate limits have
to be relaxed for a load test; [`loadtest/README.md`](loadtest/README.md) has
the exact command.

```bash
API=http://localhost:3000 PROBLEM_ID=1 k6 run loadtest/submit.js       # judge: /app
API=http://localhost:3000 k6 run loadtest/executions.js                # public API: /api/v1
```

- `submit.js`: one user per VU; each iteration lists problems, submits a real
  Python solution with a session JWT, and polls until it is graded.
- `executions.js`: one account + one API key per VU (signup → `POST
  /app/api-keys`); each iteration queues a real Python execution and polls
  until it completes.

**Results** (2021 MacBook, Docker Desktop, 8 grading + 8 execution consumers,
auth and every limit check in the request path):

| Metric | `/app` (judge) | `/api/v1` (public API) |
|---|---|---|
| Work completed | 347 submissions, **100% `Accepted`** | 354 executions, **100% `ok`** |
| HTTP requests | 2189, **0 failed** | 1847, **0 failed** |
| Create latency | `POST /app/submissions` p95 **3.75 ms** | `POST /api/v1/executions` p95 **4.93 ms** |
| Read latency | `GET /app/problems` p95 **3.31 ms** | `GET /api/v1/executions/:id` p95 **3.29 ms** |
| Time to result | p95 2.0 s | p95 2.0 s |

What each create request does:

- **`/app/submissions`**: JWT verify, rate-limit check, `INSERT`, `XADD`.
- **`/api/v1/executions`**: SHA-256 of the key plus an indexed lookup, the
  sliding-window rate limit (one Redis round trip), the atomic quota and
  in-flight check (one more), then `INSERT` and `XADD`. That extra work costs
  about a millisecond at p95, which is the concrete case for SHA-256 over
  bcrypt: bcrypt would add ~250 ms to every request.

Both APIs stay flat in single-digit milliseconds under load because all the
expensive work is absorbed by the queue and the worker pool. Time to a result
is seconds, since every run gets its own container; that gap between request
latency and work latency is the point of the architecture.

The script is in `loadtest/`, so the numbers are reproducible rather than
claimed.

## Roadmap

- **Empirical complexity analysis** — run an accepted solution across a
  geometric ladder of input sizes, measure CPU time from cgroup counters, and
  fit the growth curve to report a *measured* complexity class with a confidence
  bound. A measurement, never a proof: where `O(n)` and `O(n log n)` are
  indistinguishable within noise, it says so.

## Known limitations

Written down deliberately rather than discovered by a reader.

- **Crash recovery is incomplete.** A message whose worker dies mid-job stays
  pending and is only retried when that same consumer restarts — peers do not
  reclaim it. The fix is `XAUTOCLAIM` plus a dead-letter destination; it is not
  built yet.
- **The worker mounts the host Docker socket** in order to spawn sandbox
  containers. That is effectively root on the host, which is exactly why this
  needs a dedicated machine and cannot run on shared hosting.
- **Tokens live in `localStorage`**, so an XSS hole would expose them, and
  logout is client-side only — a stolen token stays valid until it expires.
  Moving to httpOnly cookies requires collapsing the client and API onto one
  origin.
- **Validation is uneven across the two trees.** Every `/api/v1` body goes
  through a strict `zod` schema; the judge's `/app` tree still uses narrow
  hand-written checks (language, byte caps, a JSON size limit).
- **Executions are kept forever.** There is no retention job, so the
  `executions` and `api_usage` tables grow without bound.
- **The in-flight slot expiry is a guess.** A slot a crashed worker never
  freed lingers for 10 minutes. If an execution ever legitimately waited in the
  queue longer than that, its slot would be trimmed early and the account could
  briefly exceed its concurrency cap.
- **A concurrency `429` can't say exactly when to retry.** A slot frees when
  one of the account's executions finishes, so `Retry-After: 1` is a hint, not
  a promise.
- **No webhooks, idempotency keys or batch submission** on the public API, and
  no plans/tiers — every account gets the same env-configured limits.

## Layout

A single monorepo of npm workspaces. The boundaries are enforced in code
(`npm run lint` → `scripts/check-boundaries.mjs`), not by splitting repos:
`apps/web` may import `packages/shared` and nothing else; `apps/api` may not
import the execution engine; `packages/sdk-ts` may import nothing internal at
all.

```
packages/
  shared/     cross-cutting TypeScript types / DTOs — types only, no runtime.
              The only package apps/web may import.
  engine/     sandbox execution engine: container lifecycle, limits, exec,
              timeouts, output caps, OOM detection. Given language + source +
              stdin + limits → stdout/stderr/exit/timing. Knows nothing about
              problems, grading, the queue or the database.
  infra/      infrastructure adapters: Postgres access, migration runner,
              Redis connection factory, pub/sub, both work queues, the public
              API's Redis limit scripts.
  sdk-ts/     typed TypeScript client for /api/v1. Types generated from
              openapi.yaml. (nothing internal)
apps/
  api/        Express: /app tree (session auth) + /api/v1 tree (API keys) +
              docs + WebSocket hub. Enqueues; never executes. (shared + infra)
  worker/     two consumer pools: grading (compile once, run per test case,
              stop at first failure) and one-off executions.
              (shared + infra + engine)
  web/        React + Vite + Monaco SPA. Talks to the API over HTTP. (shared)
db/
  migrations/ ordered, idempotent SQL — 001_baseline.sql is v1's end state
  seed/       problems.json
openapi.yaml          the public API's contract — source of truth
loadtest/             k6: submit.js (/app), executions.js (/api/v1)
docker-compose.yml    full real stack, one command
.env.example          every environment variable
```

## Environment variables

| Var | Used by | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | api, worker | local `postgres://postgres:judge@localhost:5432/judge` | |
| `PGSSL` | api, worker | SSL on if `DATABASE_URL` set | set `disable` for a non-SSL server (compose does) |
| `REDIS_URL` | api, worker | `redis://localhost:6379` | |
| `DEMO_MODE` | api | unset (real execution) | `true` → store submissions but never enqueue |
| `JWT_SECRET` | api | **none — required** | the API refuses to start without it (no fallback anywhere) |
| `PORT` | api | `3000` | |
| `WORKER_CONCURRENCY` | worker | `3` | concurrent grading consumers |
| `EXECUTION_WORKER_CONCURRENCY` | worker | `2` | concurrent consumers for public-API executions (a separate pool) |
| `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW_MS` | api | `120` / `60000` | public API requests per sliding window, per account |
| `API_DAILY_EXECUTION_QUOTA` | api | `1000` | executions per UTC day, per account |
| `API_MAX_CONCURRENT_EXECUTIONS` | api | `3` | executions queued or running at once, per account |
| `API_INFLIGHT_TTL_MS` | api | `600000` | how long a slot a crashed worker never freed can linger |
| `MAX_ACTIVE_API_KEYS` | api | `5` | per account |
| `EXECUTION_MAX_TIME_MS` / `EXECUTION_MAX_MEMORY_MB` | api | `5000` / `256` | the most a request may ask for (and the default) |
| `MAX_SOURCE_CODE_BYTES` / `MAX_STDIN_BYTES` | api | `65536` / `65536` | |
| `SIGNUP_RATE_*` / `LOGIN_RATE_*` / `SUBMISSION_RATE_*` | api | 3/hr, 5/15min, 20/min | the judge's `/app` limits — see `loadtest/README.md` |
| `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | `judge` / `judge` | local Postgres, read from `.env` |
| `MIGRATIONS_DIR` / `SEED_DIR` / `OPENAPI_PATH` | api, worker | resolved from repo root | override only if the layout differs |
