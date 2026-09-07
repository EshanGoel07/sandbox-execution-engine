# Load test

`submit.js` drives the full real path — API → Redis Stream → worker pool →
Docker sandbox → Postgres — with [k6](https://k6.io).

## Why the API has to be relaxed for this

The API is rate-limited by default, and the limits are deliberately strict:

| limit | default | env vars |
|---|---|---|
| signups | 3 / hour / IP | `SIGNUP_RATE_MAX`, `SIGNUP_RATE_WINDOW_MS` |
| logins | 5 / 15 min / IP | `LOGIN_RATE_MAX`, `LOGIN_RATE_WINDOW_MS` |
| submissions | 20 / min / user | `SUBMISSION_RATE_MAX`, `SUBMISSION_RATE_WINDOW_MS` |

A load test creates one user per VU (a shared user trips the per-user
submission cap; a user per iteration trips the per-IP signup cap) and then
submits far faster than a human would. Both limits have to be lifted for the
run. **Change them only for the load-test stack — the strict values are the
default everywhere else.**

## Running it

Bring the stack up with the limits relaxed and more workers:

```bash
SIGNUP_RATE_MAX=100000 \
LOGIN_RATE_MAX=100000 \
SUBMISSION_RATE_MAX=100000 \
WORKER_CONCURRENCY=8 \
docker compose up --build
```

(or export the same vars before `npm run api` / `npm run worker` for a manual
stack). Then, once at least one problem is seeded:

```bash
API=http://localhost:3000 PROBLEM_ID=1 PEAK_VUS=20 k6 run loadtest/submit.js
```

`PEAK_VUS` (default 20) sets both the ramp target and how many users `setup()`
creates.

## Results

See the "Load test" section of the top-level `README.md` for the recorded
numbers (throughput, `endpoint:submit` p95, HTTP failure rate).
