/**
 * Worker entrypoint. Runs two independent pools — one grading judge
 * submissions, one running public-API executions — each consuming its own
 * stream with its own consumers. That is the bulkhead: however deep the
 * executions queue gets, grading keeps its full capacity, and vice versa.
 *
 * SIGINT/SIGTERM trigger a graceful shutdown: in-flight jobs finish (bounded
 * by waitMs) before connections close and the process exits.
 */
import { runMigrations } from "@vj/infra";
import { WorkerPool } from "./pool";
import { processOneExecution } from "./execute";

const GRADING_CONSUMERS = Number(process.env.WORKER_CONCURRENCY) || 3;
const EXECUTION_CONSUMERS = Number(process.env.EXECUTION_WORKER_CONCURRENCY) || 2;

async function main() {
  await runMigrations();

  const grading = new WorkerPool({
    count: GRADING_CONSUMERS,
    waitMs: 2000,
    name: "worker",
    onResult: (outcome, consumerName) => {
      console.log(
        `[${consumerName}] submission ${outcome.submissionId} -> ${outcome.gradeResult.verdict} ` +
          `(${outcome.gradeResult.passedCount}/${outcome.gradeResult.totalCount})`
      );
    },
  });

  const executions = new WorkerPool({
    count: EXECUTION_CONSUMERS,
    waitMs: 2000,
    name: "executor",
    processOne: processOneExecution,
    onResult: (outcome, consumerName) => {
      console.log(
        `[${consumerName}] execution ${outcome.executionId} -> ${outcome.status}` +
          (outcome.result ? ` (${outcome.result.outcome})` : "")
      );
    },
  });

  grading.start();
  executions.start();
  console.log(
    `worker started: ${GRADING_CONSUMERS} grading consumers, ${EXECUTION_CONSUMERS} execution consumers`
  );

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nreceived ${signal}, shutting down gracefully...`);
    await Promise.all([grading.stop(), executions.stop()]);
    console.log("worker pools stopped");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
