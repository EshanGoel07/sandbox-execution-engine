-- 001_baseline — the cumulative schema as it stood at the end of v1.
--
-- v1 built the schema with ad-hoc CREATE TABLE / ALTER TABLE calls run on
-- every boot. There is no released migration history to preserve, so this
-- single file reproduces that exact end state. Every change from here is its
-- own numbered migration. Idempotent (IF NOT EXISTS throughout) so it is
-- safe even if a v1 database is pointed at the v2 runner.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS problems (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  time_limit_ms INTEGER NOT NULL DEFAULT 5000,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS test_cases (
  id              SERIAL PRIMARY KEY,
  problem_id      INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  input           TEXT NOT NULL,
  expected_output TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id                  SERIAL PRIMARY KEY,
  problem_id          INTEGER NOT NULL REFERENCES problems(id),
  language            TEXT NOT NULL,
  source_code         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'Pending',
  verdict             TEXT,
  passed_count        INTEGER,
  total_count         INTEGER,
  failed_test_ordinal INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  judged_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS submission_results (
  id                SERIAL PRIMARY KEY,
  submission_id     INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  test_case_ordinal INTEGER NOT NULL,
  verdict           TEXT NOT NULL,
  stdout            TEXT,
  stderr            TEXT,
  time_ms           INTEGER
);

-- Full problem statement (paragraph + I/O format + constraints + example).
ALTER TABLE problems     ADD COLUMN IF NOT EXISTS statement TEXT;

-- Every submission belongs to a user. Nullable only so low-level test
-- helpers that insert directly still work; the API always sets it.
ALTER TABLE submissions  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Optional custom stdin the submitter typed, and a free-text note used by
-- DEMO_MODE to explain why a submission was not executed.
ALTER TABLE submissions  ADD COLUMN IF NOT EXISTS stdin TEXT;
ALTER TABLE submissions  ADD COLUMN IF NOT EXISTS message TEXT;
