/**
 * Worker entrypoint. Wires SIGINT/SIGTERM to a graceful shutdown: in-flight
 * jobs finish (bounded by waitMs) before connections close and the process
 * exits.
 */
import { runMigrations } from "@vj/infra";
import { WorkerPool } from "./pool";

const CONSUMER_COUNT = Number(process.env.WORKER_CONCURRENCY) || 3;

async function main() {
  await runMigrations();

  const pool = new WorkerPool({
    count: CONSUMER_COUNT,
    waitMs: 2000,
    onResult: (outcome, consumerName) => {
      console.log(
        `[${consumerName}] submission ${outcome.submissionId} -> ${outcome.gradeResult.verdict} ` +
          `(${outcome.gradeResult.passedCount}/${outcome.gradeResult.totalCount})`
      );
    },
  });

  pool.start();
  console.log(`worker pool started with ${CONSUMER_COUNT} consumers`);

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nreceived ${signal}, shutting down gracefully...`);
    await pool.stop();
    console.log("worker pool stopped");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
