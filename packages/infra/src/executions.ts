/**
 * Postgres access for one-off executions (the public API's unit of work).
 *
 * Lifecycle: the API inserts a row as `queued` and enqueues its id; a worker
 * loads it, marks it `running`, runs it once in the engine, and writes the
 * result as `completed` — or `failed` if the engine itself couldn't run it.
 */
import type { ExecutionOutcome, ExecutionStatus } from "@vj/shared";
import { pool } from "./db";

export interface NewExecution {
  id: string;
  userId: number;
  apiKeyId: number;
  language: string;
  sourceCode: string;
  stdin: string;
  timeLimitMs: number;
  memoryLimitMb: number;
}

/** Everything a worker needs to run the job. */
export interface ExecutionJob {
  language: string;
  sourceCode: string;
  stdin: string;
  timeLimitMs: number;
  memoryLimitMb: number;
}

export interface ExecutionResultRecord {
  outcome: ExecutionOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  compileOutput: string;
  outputTruncated: boolean;
  /** null when the program never ran (compile error). */
  wallTimeMs: number | null;
}

/** The owner's view of an execution. No source code or stdin. */
export interface ExecutionRecord {
  id: string;
  status: ExecutionStatus;
  language: string;
  timeLimitMs: number;
  memoryLimitMb: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Present only once status is `completed`. */
  result: ExecutionResultRecord | null;
}

export async function createExecution(input: NewExecution): Promise<{ createdAt: string }> {
  const result = await pool.query(
    `INSERT INTO executions
       (id, user_id, api_key_id, language, source_code, stdin, time_limit_ms, memory_limit_mb)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING created_at`,
    [
      input.id,
      input.userId,
      input.apiKeyId,
      input.language,
      input.sourceCode,
      input.stdin,
      input.timeLimitMs,
      input.memoryLimitMb,
    ]
  );
  return { createdAt: result.rows[0].created_at };
}

// Scoped to the owning account, not the key: an account's keys are
// interchangeable credentials, and revoking one key shouldn't make results
// it created unreadable through another. Someone else's id returns null, the
// same as a missing one.
export async function getExecutionForUser(
  executionId: string,
  userId: number
): Promise<ExecutionRecord | null> {
  const result = await pool.query(
    `SELECT id, status, language, time_limit_ms, memory_limit_mb,
            outcome, exit_code, stdout, stderr, compile_output, output_truncated, wall_time_ms,
            created_at, started_at, completed_at
     FROM executions WHERE id = $1 AND user_id = $2`,
    [executionId, userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    status: row.status,
    language: row.language,
    timeLimitMs: row.time_limit_ms,
    memoryLimitMb: row.memory_limit_mb,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    result:
      row.status === "completed"
        ? {
            outcome: row.outcome,
            exitCode: row.exit_code,
            stdout: row.stdout,
            stderr: row.stderr,
            compileOutput: row.compile_output,
            outputTruncated: row.output_truncated,
            wallTimeMs: row.wall_time_ms,
          }
        : null,
  };
}

export async function getExecutionJob(executionId: string): Promise<ExecutionJob | null> {
  const result = await pool.query(
    `SELECT language, source_code, stdin, time_limit_ms, memory_limit_mb
     FROM executions WHERE id = $1`,
    [executionId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    language: row.language,
    sourceCode: row.source_code,
    stdin: row.stdin,
    timeLimitMs: row.time_limit_ms,
    memoryLimitMb: row.memory_limit_mb,
  };
}

export async function markExecutionRunning(executionId: string): Promise<void> {
  await pool.query(
    "UPDATE executions SET status = 'running', started_at = now() WHERE id = $1",
    [executionId]
  );
}

// A plain overwrite, so a redelivered message (worker crashed after running
// but before ACK) that runs the job again just replaces the first result.
export async function saveExecutionResult(
  executionId: string,
  result: ExecutionResultRecord
): Promise<void> {
  await pool.query(
    `UPDATE executions
     SET status = 'completed', outcome = $1, exit_code = $2, stdout = $3, stderr = $4,
         compile_output = $5, output_truncated = $6, wall_time_ms = $7,
         error_message = NULL, completed_at = now()
     WHERE id = $8`,
    [
      result.outcome,
      result.exitCode,
      result.stdout,
      result.stderr,
      result.compileOutput,
      result.outputTruncated,
      result.wallTimeMs,
      executionId,
    ]
  );
}

// Terminal "we couldn't run this" state, so an execution never hangs in
// `running`. The message is for operators; the API reports only the status.
export async function failExecution(executionId: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE executions
     SET status = 'failed', error_message = $1, completed_at = now()
     WHERE id = $2`,
    [message, executionId]
  );
}
