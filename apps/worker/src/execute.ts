/**
 * The one-off execution consumer — the public API's half of the worker.
 * Read one executionId, load the job from Postgres, run it ONCE in the
 * engine under the caller's limits, persist the result, ACK.
 *
 * No grading happens here: there are no test cases and nothing is compared.
 * The engine's `RunOutcome` is translated into the API's `ExecutionOutcome`
 * vocabulary and stored as-is.
 *
 * Failure handling mirrors the grading consumer (see consume.ts):
 * transient infrastructure errors leave the message pending for retry;
 * anything deterministic becomes a terminal `failed` status and is ACKed.
 *
 * Every terminal path frees the account's in-flight slot (the concurrency
 * cap) BEFORE acking. A retryable failure keeps the slot: the execution is
 * still in flight, just waiting for another attempt.
 */
import type Redis from "ioredis";
import {
  executionQueue,
  failExecution,
  getExecutionJob,
  markExecutionRunning,
  releaseExecutionSlot,
  saveExecutionResult,
} from "@vj/infra";
import type { ExecutionResultRecord } from "@vj/infra";
import { runOnce } from "@vj/engine";
import type { RunOnceResult } from "@vj/engine";
import { isLanguage } from "@vj/shared";
import { RetryableError, isRetryable } from "./retry";

export interface ExecutionJobOutcome {
  id: string;
  executionId: string;
  status: "completed" | "failed";
  result: ExecutionResultRecord | null;
}

const MB = 1024 * 1024;

function toResultRecord({ compile, run }: RunOnceResult): ExecutionResultRecord {
  // compile.stderr is kept even on success — compiler warnings are useful.
  const compileOutput = compile.stderr;

  if (!compile.ok || run === null) {
    return {
      outcome: "compile_error",
      exitCode: null,
      stdout: "",
      stderr: "",
      compileOutput,
      outputTruncated: compile.outputTruncated,
      wallTimeMs: null,
    };
  }

  if (run.kind === "timed_out") {
    return {
      outcome: "timeout",
      exitCode: null,
      stdout: "",
      stderr: "",
      compileOutput,
      outputTruncated: false,
      wallTimeMs: run.timeMs,
    };
  }

  return {
    // "ok" | "runtime_error" | "out_of_memory" are the same words in both
    // vocabularies; only the timeout is renamed.
    outcome: run.kind,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    compileOutput,
    outputTruncated: run.outputTruncated,
    wallTimeMs: run.timeMs,
  };
}

export async function processOneExecution(
  consumerName: string,
  waitMs: number,
  client: Redis
): Promise<ExecutionJobOutcome | null> {
  await executionQueue.ensureGroup();

  const message =
    (await executionQueue.readOwnPending(consumerName, client)) ??
    (await executionQueue.readNext(consumerName, waitMs, client));
  if (!message) return null;
  const { id, jobId: executionId } = message;

  const job = await getExecutionJob(executionId);
  if (!job) {
    await executionQueue.ack(id, client);
    return null;
  }

  // Terminal: free the account's concurrency slot, then ACK.
  const finish = async () => {
    await releaseExecutionSlot(job.userId, executionId);
    await executionQueue.ack(id, client);
  };

  // The API validates the language before inserting, so this only fires for a
  // row written some other way. Terminal, not retryable.
  if (!isLanguage(job.language)) {
    await failExecution(executionId, `Unsupported language "${job.language}".`);
    await finish();
    return { id, executionId, status: "failed", result: null };
  }

  await markExecutionRunning(executionId);

  let result: ExecutionResultRecord;
  try {
    const run = await runOnce(
      job.language,
      job.sourceCode,
      job.stdin,
      { wallClockMs: job.timeLimitMs },
      { limits: { memoryBytes: job.memoryLimitMb * MB } }
    );
    result = toResultRecord(run);
  } catch (err) {
    if (isRetryable(err)) throw new RetryableError(err);
    console.error(`[${consumerName}] execution ${executionId} internal error:`, err);
    await failExecution(executionId, err instanceof Error ? err.message : String(err));
    await finish();
    return { id, executionId, status: "failed", result: null };
  }

  await saveExecutionResult(executionId, result);
  await finish();
  return { id, executionId, status: "completed", result };
}
