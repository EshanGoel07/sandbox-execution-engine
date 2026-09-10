/**
 * Postgres access for API keys. This module only ever sees key *hashes* —
 * generating a key and hashing it happen in the API, so a raw key never
 * reaches the data layer (or a query log).
 */
import { pool } from "./db";

/** What a key's owner may see about it. Never includes the key or its hash. */
export interface ApiKeySummary {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The auth middleware's view of a key: who it belongs to, and whether it's live. */
export interface ApiKeyIdentity {
  id: number;
  userId: number;
  revoked: boolean;
}

const SUMMARY_COLUMNS = "id, name, key_prefix, created_at, last_used_at, revoked_at";

function toSummary(row: any): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Creates a key unless the user already holds `maxActive` unrevoked keys, in
 * which case it returns null.
 *
 * The count and the insert must not race: two concurrent creates could both
 * see "4 active" and both insert, ending at 6. Locking the user's row
 * (SELECT ... FOR UPDATE) serializes key creation per user for the length of
 * this transaction, so the cap holds under concurrency — the same
 * check-then-act hazard as signup, closed with a lock instead of a unique
 * constraint because a count can't be a constraint.
 */
export async function createApiKey(input: {
  userId: number;
  name: string;
  keyPrefix: string;
  keyHash: string;
  maxActive: number;
}): Promise<ApiKeySummary | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
    const active = await client.query(
      "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL",
      [input.userId]
    );
    if (Number(active.rows[0].n) >= input.maxActive) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SUMMARY_COLUMNS}`,
      [input.userId, input.name, input.keyPrefix, input.keyHash]
    );
    await client.query("COMMIT");
    return toSummary(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** All of a user's keys, revoked ones included (their history stays visible). */
export async function listApiKeys(userId: number): Promise<ApiKeySummary[]> {
  const result = await pool.query(
    `SELECT ${SUMMARY_COLUMNS} FROM api_keys WHERE user_id = $1 ORDER BY id DESC`,
    [userId]
  );
  return result.rows.map(toSummary);
}

/**
 * Soft-revokes one of the user's keys. Idempotent — revoking an already
 * revoked key keeps its original revoked_at. Returns false if the key doesn't
 * exist or belongs to someone else (the caller turns both into the same 404).
 */
export async function revokeApiKey(keyId: number, userId: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [keyId, userId]
  );
  return result.rows.length > 0;
}

/** One indexed equality lookup on the UNIQUE key_hash column. */
export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyIdentity | null> {
  const result = await pool.query(
    "SELECT id, user_id, revoked_at FROM api_keys WHERE key_hash = $1",
    [keyHash]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { id: row.id, userId: row.user_id, revoked: row.revoked_at !== null };
}

/**
 * Records that a key was used, at most once a minute per key. Updating on
 * every request would turn every read into a row write (and a hot row under
 * load); minute resolution is all "last used" needs.
 */
export async function touchApiKeyLastUsed(keyId: number): Promise<void> {
  await pool.query(
    `UPDATE api_keys SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [keyId]
  );
}
