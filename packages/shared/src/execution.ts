/**
 * Vocabulary for one-off executions (the public /api/v1 surface).
 *
 * These are deliberately NOT grading terms. An execution never has a
 * `Verdict` — nothing is compared against an expected output. It reports
 * what happened to the program, and nothing more.
 */

/**
 * Lifecycle of an execution. `failed` means the service could not run it (an
 * engine error) — distinct from `completed` with a non-`ok` outcome, which
 * means it ran and the *program* failed.
 */
export type ExecutionStatus = "queued" | "running" | "completed" | "failed";

/** What happened to the program. Only meaningful once status is `completed`. */
export type ExecutionOutcome =
  | "ok"
  | "compile_error"
  | "runtime_error"
  | "timeout"
  | "out_of_memory";
