# Load test

Two [k6](https://k6.io) scripts, both driving the full real path — API →
Redis Stream → worker pool → Docker sandbox → Postgres:

| script | surface | auth | request-path latency to watch |
|---|---|---|---|
| `submit.js` | the judge's `/app` tree | session JWT | `endpoint:submit` p95 |
| `executions.js` | the public `/api/v1` API | API key | `endpoint:execute` p95 |

## Why the API has to be relaxed for this

The API is rate-limited by default, and the limits are deliberately strict:

| limit | default | env vars |
|---|---|---|
| signups | 3 / hour / IP | `SIGNUP_RATE_MAX`, `SIGNUP_RATE_WINDOW_MS` |
| logins | 5 / 15 min / IP | `LOGIN_RATE_MAX`, `LOGIN_RATE_WINDOW_MS` |
| submissions | 20 / min / user | `SUBMISSION_RATE_MAX`, `SUBMISSION_RATE_WINDOW_MS` |
| public API requests | 120 / min / account | `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_MS` |

A load test creates one user per VU (a shared user trips the per-user
submission cap; a user per iteration trips the per-IP signup cap) and then
submits far faster than a human would. For `executions.js`, each VU also
polls about twice a second, which is over the public API's per-account
request limit. These limits have to be lifted for the run. **Change them only
for the load-test stack — the strict values are the default everywhere else.**

The public API's daily quota (1000/account) and concurrency cap (3/account)
don't need relaxing: each VU has its own account and one execution in flight.

## Running it

Bring the stack up with the limits relaxed and more workers:

```bash
SIGNUP_RATE_MAX=100000 \
LOGIN_RATE_MAX=100000 \
SUBMISSION_RATE_MAX=100000 \
API_RATE_LIMIT_MAX=100000 \
WORKER_CONCURRENCY=8 \
EXECUTION_WORKER_CONCURRENCY=8 \
docker compose up --build
```

(or export the same vars before `npm run api` / `npm run worker` for a manual
stack). Then, once at least one problem is seeded:

```bash
API=http://localhost:3000 PROBLEM_ID=1 PEAK_VUS=20 k6 run loadtest/submit.js
API=http://localhost:3000 PEAK_VUS=20 k6 run loadtest/executions.js
```

`PEAK_VUS` (default 20) sets both the ramp target and how many users `setup()`
creates.

## Results

See the "Load test" section of the top-level `README.md` for the recorded
numbers (throughput, p95 latencies, HTTP failure rate).
