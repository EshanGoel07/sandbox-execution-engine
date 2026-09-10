/**
 * Retryable vs non-retryable failure, shared by both consumers (grading and
 * one-off execution). Transient infrastructure failures leave the message
 * unacked so it is retried; everything else is treated as deterministic and
 * turned into a terminal state, because retrying it would just poison the
 * queue.
 */

/** Thrown for transient failures: the message is deliberately left unacked. */
export class RetryableError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RetryableError";
  }
}

// Transient infrastructure failures — worth retrying, not worth converting to
// a terminal result.
const RETRYABLE_RE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|Cannot connect to the Docker daemon|connect ENOENT|Connection is closed|read ECONNRESET/i;

export function isRetryable(err: unknown): boolean {
  return RETRYABLE_RE.test(err instanceof Error ? `${err.message}` : String(err));
}
