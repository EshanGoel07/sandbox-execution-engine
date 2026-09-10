-- 003_api_usage — one row per authenticated /api/v1 request.
--
-- Limits are enforced per ACCOUNT (in Redis, on the request path); this table
-- is the durable record, and it attributes every request to the KEY that made
-- it — so "which key is making these calls?" stays answerable even though
-- keys share one account-wide budget.
--
-- Written in batches off the request's critical path (see
-- apps/api/src/routes/v1/usage.ts): usage is analytics, not billing, so a
-- crash can lose up to one flush interval of rows by design.

CREATE TABLE IF NOT EXISTS api_usage (
  id          BIGSERIAL PRIMARY KEY,
  api_key_id  INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  -- Denormalised from api_keys so account-level questions don't need a join.
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The route pattern ("GET /api/v1/executions/:id"), never the raw URL: ids
  -- in the path would make every row a distinct endpoint.
  endpoint    TEXT NOT NULL,
  status_code SMALLINT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);

-- Serves the per-key usage view (one key, a date range).
CREATE INDEX IF NOT EXISTS api_usage_key_time_idx ON api_usage (api_key_id, created_at);
