-- 002_public_api — API keys and one-off executions for the public /api/v1 surface.
--
-- An *execution* is not a submission: it has no problem, no test cases and no
-- verdict — just language + source + stdin + limits in, stdout/stderr/exit
-- code out. Grading is built on top of the engine; executions ARE the engine,
-- exposed. So they get their own table rather than a nullable problem_id on
-- submissions.

-- Keys are credentials, not the unit of metering. Usage limits are enforced
-- per account (user_id); a key only says "this request is from that account",
-- and is recorded per request so usage can still be attributed to a key.
CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- "vj_live_" + the first 8 random chars. Display / identification only
  -- (e.g. spotting a leaked key in a log); never used for lookup.
  key_prefix   TEXT NOT NULL,
  -- hex SHA-256 of the full key. UNIQUE doubles as the lookup index: an
  -- unsalted hash of a high-entropy key is deterministic, so auth is one
  -- indexed equality lookup (see apps/api/src/auth/api-key.ts for why this
  -- is SHA-256 and not bcrypt).
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  -- Soft revoke: the row stays so executions keep their FK and the key's
  -- history stays auditable.
  revoked_at   TIMESTAMPTZ
);

-- Serves "list my keys" and the active-key cap count.
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS executions (
  -- "exec_" + 22 random base62 chars. Random rather than SERIAL so ids can't
  -- be enumerated and don't reveal how many executions the service has run.
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id       INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  language         TEXT NOT NULL,
  source_code      TEXT NOT NULL,
  stdin            TEXT NOT NULL DEFAULT '',
  -- The effective limits after defaults were applied — what the run actually
  -- got, echoed back to the client.
  time_limit_ms    INTEGER NOT NULL,
  memory_limit_mb  INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  -- Set once status = 'completed'. 'failed' means *we* couldn't run it (an
  -- engine error), which is different from the program failing.
  outcome          TEXT
                   CHECK (outcome IN ('ok', 'compile_error', 'runtime_error', 'timeout', 'out_of_memory')),
  exit_code        INTEGER,
  stdout           TEXT,
  stderr           TEXT,
  compile_output   TEXT,
  output_truncated BOOLEAN,
  wall_time_ms     INTEGER,
  -- Operator-facing note for status = 'failed'. Not returned by the API.
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS executions_user_idx ON executions (user_id, created_at DESC);
