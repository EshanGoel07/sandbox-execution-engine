/**
 * Every API tunable in one place. All env-overridable; the defaults are the
 * strict values a real deployment should run with.
 */

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// When DEMO_MODE=true the API still accepts and persists submissions, but
// never puts them on the queue — so no worker and no Docker sandbox is
// required. Arbitrary code execution isn't something you can safely expose
// on shared free hosting without a dedicated, locked-down Docker host, so the
// public demo deliberately stops here and points people at the one-command
// local docker-compose stack instead. Auth, profiles and submission history
// all work exactly the same in demo mode — only the sandbox step is skipped.
// The public execution API, whose whole job is running code, answers 503.
export const DEMO_MODE = process.env.DEMO_MODE === "true";

// Cap on the JSON request body. Source code is the only large field and is
// separately capped below; everything else is tiny.
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? "256kb";

// Hard cap on a single program's source code (judge submissions and public
// executions alike). 64 KiB is far more than any real solution and keeps a
// hostile client from filling Postgres or the sandbox copy with megabytes.
export const MAX_SOURCE_CODE_BYTES = envInt("MAX_SOURCE_CODE_BYTES", 64 * 1024);

// --- /app tree: session-auth rate limits (express-rate-limit) ---------------
// The load test relaxes these via the same env vars (see loadtest/README.md).
export const SIGNUP_RATE_WINDOW_MS = envInt("SIGNUP_RATE_WINDOW_MS", 60 * 60 * 1000); // 1h
export const SIGNUP_RATE_MAX = envInt("SIGNUP_RATE_MAX", 3);
export const LOGIN_RATE_WINDOW_MS = envInt("LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000); // 15m
export const LOGIN_RATE_MAX = envInt("LOGIN_RATE_MAX", 5);
export const SUBMISSION_RATE_WINDOW_MS = envInt("SUBMISSION_RATE_WINDOW_MS", 60 * 1000); // 1m
export const SUBMISSION_RATE_MAX = envInt("SUBMISSION_RATE_MAX", 20);

// --- API keys ----------------------------------------------------------------

// Usage limits on the public API are enforced per ACCOUNT, not per key. Keys
// are credentials — they say which account a request is from — and are free
// to mint. If limits were per key, anyone could multiply their own quota by
// minting more keys; a per-key limit would only mean something if key
// creation were capped anyway. So the account is the unit that's metered,
// and this cap exists to keep key sprawl manageable, not to enforce usage.
// (This is how production API products meter: org/account-level limits,
// keys as interchangeable credentials, usage still attributed per key.)
export const MAX_ACTIVE_API_KEYS = envInt("MAX_ACTIVE_API_KEYS", 5);

// --- /api/v1 execution limits --------------------------------------------------

// A request may ask for any limit inside [min, max]; omitted means the max.
// Out-of-range values are REJECTED, not silently clamped — a client that asked
// for 10s and quietly got 5s would just see an unexplained timeout.
export const EXECUTION_TIME_MS = {
  min: 100,
  max: envInt("EXECUTION_MAX_TIME_MS", 5000),
};
export const EXECUTION_MEMORY_MB = {
  min: 32,
  max: envInt("EXECUTION_MAX_MEMORY_MB", 256),
};

// stdin rides in the JSON body next to the source; cap it separately so the
// error names the field that's too big.
export const MAX_STDIN_BYTES = envInt("MAX_STDIN_BYTES", 64 * 1024);

// --- /api/v1 usage controls (per ACCOUNT — see MAX_ACTIVE_API_KEYS above) -----
// Free-tier values. There is no plans table: every account gets these, and
// each is env-overridable (the load test and the limits test lower/raise them).

// Requests of any kind, per sliding window. Polling GETs count too, so this
// has to leave room for a client waiting on a few executions at once.
export const API_RATE_LIMIT_MAX = envInt("API_RATE_LIMIT_MAX", 120);
export const API_RATE_LIMIT_WINDOW_MS = envInt("API_RATE_LIMIT_WINDOW_MS", 60 * 1000);

// Executions accepted per UTC day.
export const API_DAILY_EXECUTION_QUOTA = envInt("API_DAILY_EXECUTION_QUOTA", 1000);

// Executions queued or running at once. This is what stops one account from
// filling the executions queue and starving everyone else's.
export const API_MAX_CONCURRENT_EXECUTIONS = envInt("API_MAX_CONCURRENT_EXECUTIONS", 3);

// How long an in-flight slot can outlive its execution if the worker never
// frees it (a crash). Must exceed any real queue wait + compile + run, or a
// slow-but-alive execution's slot would be reclaimed early and the account
// could briefly exceed its cap. Only matters after a crash.
export const API_INFLIGHT_TTL_MS = envInt("API_INFLIGHT_TTL_MS", 10 * 60 * 1000);
