/**
 * Ordered, idempotent SQL migrations.
 *
 * Replaces v1's "run CREATE TABLE / ALTER TABLE on every boot" approach.
 * Each file in db/migrations/ is applied once, in filename order, inside a
 * transaction, and recorded in schema_migrations. Re-running is a no-op.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { pool } from "./db";

// db/migrations lives at the repo root. From packages/infra/{src,dist}/ that
// is three levels up. MIGRATIONS_DIR overrides it (e.g. in a container where
// the layout differs).
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? join(__dirname, "..", "..", "..", "db", "migrations");

export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`migrate: applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
