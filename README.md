# Sandbox Execution Engine

A code execution engine that runs **untrusted source code inside a locked-down
Docker container** — memory and PID limits enforced by cgroups, no network, a
non-root user, and a wall-clock kill — and an asynchronous grading pipeline
built on top of it.

An online judge ships in this repo as the **reference client**: it consumes the
engine exactly the way a third party would, which is what keeps the boundary
between "run this code" and "grade this submission" honest.

Built to understand, end to end, how systems like Judge0 or the machinery behind
Codeforces actually work: OS-level isolation, a durable work queue, a worker
pool, pub/sub between processes, and live result streaming.

**Status:** the engine, the grading pipeline and the reference client are
complete and tested. A public key-authenticated HTTP API and empirical
complexity analysis are in progress — see [Roadmap](#roadmap).

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
- Distinguishes the ways a program can fail: OOM kill (read from Docker's
  `OOMKilled` state, not guessed), wall-clock timeout, non-zero exit, and
  compile failure.

**The grading pipeline** turns that into verdicts.

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
     │  POST /auth/login ────────▶│  (Express)                   │
     │  ◀──── JWT ────────────────┤   bcrypt verify, sign JWT    │
     │                            │                              │
     │  POST /submissions ───────▶│   requireAuth (Bearer JWT)   │
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

**Why it's shaped this way:**

| Decision | Reason |
|---|---|
| Namespaces + cgroups via Docker | Namespaces limit what the process can *see* (no network, own PID space); cgroups limit what it can *consume* (256 MB RAM, 64 PIDs). Docker packages both plus the language image. |
| App-level wall-clock timeout *on top of* cgroups | cgroups cap CPU-time consumed, not time elapsed. A `sleep(3600)` submission burns ~0% CPU but still has to be killed. |
| Redis **Stream + consumer group** (not a plain list) | If a worker dies mid-job the message stays pending and unacked instead of vanishing — nothing is silently lost. |
| Queue payload is **just a `submissionId`** | Postgres is the source of truth, so a worker always grades current DB state, and the queue stays cheap regardless of submission size. |
| One Redis connection **per worker consumer** | ioredis serializes commands per connection; a blocking `XREADGROUP` on a shared connection would stall every other consumer. |
| **Compile once, run many** | One persistent sandbox container per submission (`sleep infinity` + `exec`), compiled once, then one `exec` per test case — not N containers / N recompiles. |
| **Stop at first failing test** | Matches real judges, saves compute, and avoids a trap: Docker's `OOMKilled` flag is set at the container level and stays set, so reusing a container after an MLE could mislabel a later test. |
| Worker → API over **Redis Pub/Sub** (separate processes) | The worker and the API scale and fail independently. They don't call each other; they exchange `{submissionId, status}` messages. |
| **One** Redis subscriber for the whole API, fanned out in-process | A `SUBSCRIBE` puts a connection in subscriber-only mode. One subscriber → a `Map<submissionId, Set<socket>>` is all that's needed; the update only has to reach the process once. |
| **Snapshot + subscribe** on WS connect | A client can subscribe *after* the worker already finished, and would hang forever. On subscribe, the hub registers for live pushes *and* sends a DB-backed status snapshot. |
| `GET /problems/:id` omits `expected_output` | A real judge doesn't hand clients the answer key. |
| **JWT, not server sessions** | The client is a separate origin from the API, which makes cookie auth awkward without collapsing them behind one host. A bearer token carries only the user id; everything else is a Postgres lookup. The trade-off is real and documented under [Known limitations](#known-limitations). |
| Auth is **independent of the sandbox** | `DEMO_MODE` skips only the enqueue step, so the API, auth and WebSocket paths can be exercised on a host that cannot safely execute code. |
| **Engine/client boundary enforced in code** | `apps/web` may import `packages/shared` and nothing else; `apps/api` may not import the execution engine. `npm run lint` fails the build on a violation, so the separation cannot rot quietly. |
| **A worker never throws a message into limbo** | An unprocessable job (unknown language, say) is marked `Internal Error`, published, and `XACK`ed. Without that, a poison message stays unacknowledged forever and freezes the submission in `Judging`. Genuinely transient failures still rethrow, so the message stays pending and redelivers. |

## Accounts & auth

- `POST /auth/signup` / `POST /auth/login` -> `{ token, user }`. Passwords are
  hashed with bcrypt at cost 12; the JWT (7-day expiry, HS256, algorithm pinned
  on verify) carries only `sub: userId`. `JWT_SECRET` has no fallback anywhere —
  the API refuses to start without it.
- Every submission route is scoped to its owner. `GET /submissions/:id` returns
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
- **API:** Express
- **Auth:** `bcryptjs` (cost 12) + `jsonwebtoken` (JWT, HS256) + `express-rate-limit`
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
- API → http://localhost:3000
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

Against the **real** (non-demo) local stack, with `WORKER_CONCURRENCY=8`:

```bash
JWT_SECRET=dev-secret npm run api &
WORKER_CONCURRENCY=8 npm run worker &
API=http://localhost:3000 k6 run loadtest/submit.js
```

`setup()` signs up one load-test user; each iteration then lists problems,
submits a real Python solution (`Authorization: Bearer`), and polls until
the worker marks it `Done` — exercising
API → Redis Stream → worker → Docker sandbox → Postgres under a ramp to
20 virtual users over 80s.

**Results** (2021 MacBook, Docker Desktop, `WORKER_CONCURRENCY=8`, ramp to 20 VUs
over 80 s, measured with auth and rate limiting in the request path):

| Metric | Value |
|---|---|
| Submissions graded | 340, **100% `Accepted`** |
| HTTP requests | **0 failed** (`http_req_failed` 0.00%) |
| `POST /submissions` latency | p95 **4.23 ms** (JWT verify + rate-limit check + `INSERT` + `XADD`) |
| `GET /problems` latency | p95 **4.01 ms** |

The API stays flat in single-digit milliseconds under load because a submission
is a JWT verification, one `INSERT` and one `XADD` — all the expensive work is
absorbed by the queue and the worker pool. End-to-end time to a verdict is
seconds, since each submission gets its own container; that gap between request
latency and work latency is the point of the architecture.

The script is in `loadtest/`, so the numbers are reproducible rather than
claimed.

## Roadmap

- **Public execution API** — `POST /api/v1/executions` authenticated by API
  keys, with per-key rate limits, daily quotas and an in-flight concurrency cap,
  documented with OpenAPI. The reference client keeps working unchanged; it
  simply stops being the only consumer.
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
- **Validation is targeted, not blanket.** The submission path enforces
  language, byte caps and a JSON size limit; other request bodies use narrow
  hand-written checks. A schema layer belongs with the public API.

## Layout

A single monorepo of npm workspaces. The engine/client boundary is enforced
in code (`npm run lint` → `scripts/check-boundaries.mjs`), not by splitting
repos: `apps/web` may import `packages/shared` and nothing else; `apps/api`
may not import the execution engine.

```
packages/
  shared/     cross-cutting TypeScript types / DTOs — types only, no runtime.
              The only package apps/web may import.
  engine/     sandbox execution engine: container lifecycle, limits, exec,
              timeout, RunOutcome detection. Given language + source + stdin +
              limits → stdout/stderr/exit/timing. Knows nothing about
              problems, grading, the queue or the database.
  infra/      infrastructure adapters: Postgres access, migration runner,
              Redis connection factory, pub/sub, submission-stream enqueue.
apps/
  api/        Express gateway + WebSocket hub + auth. Enqueues; never executes.
              (shared + infra)
  worker/     queue consumer + grading loop (compile once, run per test case,
              stop at first failure). (shared + infra + engine)
  web/        React + Vite + Monaco SPA. Talks to the API over HTTP. (shared)
db/
  migrations/ ordered, idempotent SQL — 001_baseline.sql is v1's end state
  seed/       problems.json
loadtest/submit.js    k6 script
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
| `WORKER_CONCURRENCY` | worker | `3` | number of concurrent consumers |
| `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | `judge` / `judge` | local Postgres, read from `.env` |
| `MIGRATIONS_DIR` / `SEED_DIR` | api, worker | resolved from repo root | override only if the layout differs |
