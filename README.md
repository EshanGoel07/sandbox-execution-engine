# Virtual Judge

A from-scratch **online judge** — the kind of system behind Codeforces or
LeetCode — that takes a code submission, runs it inside a locked-down
Docker sandbox against a set of test cases, and streams the verdict back to
the browser in real time.

Built as a learning project to understand, end to end, how one of these
systems actually works: OS-level isolation, an async work queue, a
worker pool, pub/sub between processes, and a live WebSocket UI.

**Live demo:** _<add Render URL after deploy>_
&nbsp;·&nbsp; **Demo video:** _<add link>_

> The public demo runs in **DEMO_MODE**: it accepts submissions, stores
> them, and exercises the full API + WebSocket path, but it does **not**
> execute your code. Arbitrary code execution can't be safely exposed on
> shared free hosting without a dedicated, isolated Docker host. To see
> real judging, run the whole stack locally with one command — see
> [Run it locally](#run-it-locally).

<!-- DEMO GIF: replace with docs/demo.gif once recorded -->
<!-- ![Virtual Judge demo](docs/demo.gif) -->

---

## What it does

- **Sign up / log in** (bcrypt-hashed passwords, JWT sessions). Every
  submission belongs to a user — submitting requires being logged in.
- A **LeetCode-style split-pane problem page**: the statement (and a
  per-problem "Submissions" tab) on the left; language picker, Monaco
  editor, custom stdin, and live results on the right.
- Submit C++, Java, or Python. Each submission is compiled once, then run
  against every test case in a fresh sandbox with a memory cap, a PID cap,
  no network, and a wall-clock timeout.
- Verdicts: `Accepted`, `Wrong Answer`, `Compile Error`, `Runtime Error`,
  `Time Limit Exceeded`, `Memory Limit Exceeded`. Grading stops at the
  first failing test case (like real judges).
- The browser shows the status transition **Queued → Judging → verdict**
  live over a WebSocket, plus the per-test-case breakdown and which test
  it stopped on.
- A **profile / dashboard**: email, problems-solved count, acceptance
  rate, and full submission history linking back to each problem.

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
| **JWT, not server sessions** | The frontend and API are served from different origins in the deployed demo, which makes cookie auth awkward. A bearer token (localStorage → `Authorization` header) sidesteps that; the token carries only the user id, everything else is a Postgres lookup. |
| Auth is **independent of the sandbox** | `DEMO_MODE` only skips the enqueue step. Signup, login, the dashboard and submission history all work identically on the live demo — you just get a "not run in the demo" verdict instead of a real one. |

## Accounts & auth

- `POST /auth/signup` / `POST /auth/login` → `{ token, user }`. Passwords
  are hashed with bcrypt (`bcryptjs`, 10 rounds); the JWT (`jsonwebtoken`,
  7-day expiry, `JWT_SECRET`) carries only `sub: userId`.
- The SPA stores the token in `localStorage` and sends it as
  `Authorization: Bearer <token>`. `POST /submissions` and
  `GET /problems/:id/submissions` are behind `requireAuth`; `GET /profile`
  returns the user's stats + history.
- `submissions.user_id` links every submission to its author. Solved count =
  distinct problems with an `Accepted` submission; acceptance rate =
  accepted / total submissions.

## Tech stack

- **Language:** TypeScript everywhere (shared types, engine, infra, API, worker, web)
- **Sandbox:** Docker via `dockerode` — `gcc:13`, `eclipse-temurin:21-jdk`,
  `python:3.12-alpine` images, each running as a non-root user
- **Queue:** Redis Streams + consumer groups (`ioredis`)
- **Real-time:** Redis Pub/Sub → `ws` WebSocket gateway
- **DB:** PostgreSQL (`pg`)
- **API:** Express
- **Auth:** `bcryptjs` + `jsonwebtoken` (JWT)
- **Frontend:** React + Vite + `@monaco-editor/react` + React Router
- **Load testing:** k6

## Run it locally

**Full real stack (actual code execution) — one command:**

```bash
git clone https://github.com/EshanGoel07/virtual-judge.git
cd virtual-judge
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

**Results** (2021 MacBook, Docker Desktop, `WORKER_CONCURRENCY=8`):

| Metric | Value |
|---|---|
| Submissions graded | 347, **100% `Accepted`**, 0 errors |
| HTTP requests | 2,181 total, **0 failed** (`http_req_failed` 0.00%) |
| `GET /problems` latency | p95 **2.95 ms** |
| `POST /submissions` latency | p95 **3.98 ms** (JWT verify + INSERT + XADD) |
| Throughput | ~27 req/s, **~4.3 fully-graded submissions/s** |
| Time to verdict (poll loop) | avg **1.65 s**, p95 2.0 s — floored by the 0.5 s client poll interval; the WebSocket push path delivers verdicts sub-second |

The API stays flat (single-digit-ms) under load because a submission is
just a JWT verification, one `INSERT`, and one `XADD`; all the real work
is absorbed by the queue and the worker pool.

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
render.yaml           public demo blueprint (DEMO_MODE=true)
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
