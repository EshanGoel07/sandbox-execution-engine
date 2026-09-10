/**
 * Postgres access for api_usage: batched writes from the API's usage
 * recorder, and the per-key daily roll-up behind GET /app/api-keys/:id/usage.
 */
import { pool } from "./db";

export interface UsageRecord {
  apiKeyId: number;
  userId: number;
  endpoint: string;
  statusCode: number;
  durationMs: number;
  createdAt: Date;
}

/**
 * One INSERT for the whole batch: each column goes in as an array and
 * `unnest` zips them back into rows — a single round trip and a single
 * statement however many requests the batch holds, still fully parameterised.
 */
export async function insertUsageBatch(records: UsageRecord[]): Promise<void> {
  if (records.length === 0) return;
  await pool.query(
    `INSERT INTO api_usage (api_key_id, user_id, endpoint, status_code, duration_ms, created_at)
     SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::smallint[], $5::int[], $6::timestamptz[])`,
    [
      records.map((r) => r.apiKeyId),
      records.map((r) => r.userId),
      records.map((r) => r.endpoint),
      records.map((r) => r.statusCode),
      records.map((r) => r.durationMs),
      records.map((r) => r.createdAt.toISOString()),
    ]
  );
}

export interface ApiKeyUsageDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  requests: number;
  /** Executions accepted (202) — what counts against the daily quota. */
  executionsCreated: number;
  /** 429s of any kind: rate, quota or concurrency. */
  throttled: number;
  /** Other 4xx/5xx responses. */
  errors: number;
}

/**
 * Daily usage for one key over the last `days` UTC days, oldest first. Null
 * if the key isn't the user's (the caller turns that into a 404, the same as
 * a missing key). Days with no requests are omitted.
 */
export async function getApiKeyUsage(
  keyId: number,
  userId: number,
  days: number
): Promise<ApiKeyUsageDay[] | null> {
  const owner = await pool.query("SELECT 1 FROM api_keys WHERE id = $1 AND user_id = $2", [
    keyId,
    userId,
  ]);
  if (owner.rows.length === 0) return null;

  const result = await pool.query(
    `SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
            COUNT(*) AS requests,
            COUNT(*) FILTER (WHERE endpoint = 'POST /api/v1/executions' AND status_code = 202) AS executions_created,
            COUNT(*) FILTER (WHERE status_code = 429) AS throttled,
            COUNT(*) FILTER (WHERE status_code >= 400 AND status_code <> 429) AS errors
     FROM api_usage
     WHERE api_key_id = $1
       -- UTC midnight, (days - 1) days ago, as a timestamptz. (A bare date
       -- compared with a timestamptz would be read in the session time zone.)
       AND created_at >= (((now() AT TIME ZONE 'UTC')::date - ($2::int - 1))::timestamp AT TIME ZONE 'UTC')
     GROUP BY 1
     ORDER BY 1`,
    [keyId, days]
  );
  return result.rows.map((r) => ({
    day: r.day,
    requests: Number(r.requests),
    executionsCreated: Number(r.executions_created),
    throttled: Number(r.throttled),
    errors: Number(r.errors),
  }));
}
