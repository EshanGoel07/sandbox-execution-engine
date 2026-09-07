/**
 * Idempotent demo seed: makes sure a handful of classic problems exist so
 * the problems list isn't empty on a fresh database. Safe to run on every
 * boot — it creates a problem only if one with that title is missing, and
 * always refreshes the statement text (so an edit to db/seed/problems.json
 * is picked up on redeploy without wiping the DB).
 *
 * Run directly:  npm run seed
 */
import { readFileSync } from "fs";
import { join } from "path";
import { pool, createProblem, NewProblem } from "./db";
import { runMigrations } from "./migrate";

const SEED_DIR = process.env.SEED_DIR ?? join(__dirname, "..", "..", "..", "db", "seed");

function loadProblems(): NewProblem[] {
  return JSON.parse(readFileSync(join(SEED_DIR, "problems.json"), "utf8")) as NewProblem[];
}

export async function seed(): Promise<void> {
  await runMigrations();
  for (const p of loadProblems()) {
    const existing = await pool.query("SELECT id FROM problems WHERE title = $1", [p.title]);
    if (existing.rows.length > 0) {
      await pool.query("UPDATE problems SET statement = $1 WHERE id = $2", [
        p.statement ?? null,
        existing.rows[0].id,
      ]);
      console.log(`seed: refreshed statement for "${p.title}" (#${existing.rows[0].id})`);
    } else {
      const id = await createProblem(p);
      console.log(`seed: created problem ${id} — ${p.title}`);
    }
  }
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
