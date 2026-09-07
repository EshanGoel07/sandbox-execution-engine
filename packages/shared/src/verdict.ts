/**
 * The vocabulary every part of the system agrees on.
 *
 * `Verdict` is a *grading* outcome — it answers "was this submission correct?".
 * The execution engine never produces a Verdict; it produces a lower-level
 * `RunOutcome` (see @vj/engine) that the worker's grading loop maps onto one
 * of these.
 */
export type Verdict =
  | "Accepted"
  | "Wrong Answer"
  | "Compile Error"
  | "Runtime Error"
  | "Time Limit Exceeded"
  | "Memory Limit Exceeded"
  // The submission could not be graded through no fault of the code: an
  // unsupported language slipped past validation, or the engine hit a
  // deterministic error. It is a terminal state so the submission never
  // hangs in "Judging" — see the worker's poison-message handling.
  | "Internal Error";

/** Lifecycle of a submission row, independent of its eventual verdict. */
export type SubmissionStatus = "Pending" | "Judging" | "Done";

/** Languages the judge can compile and run. */
export type Language = "cpp" | "java" | "python";

export const LANGUAGES: readonly Language[] = ["cpp", "java", "python"];

/**
 * Type guard for untrusted input (request bodies, DB rows written by older
 * code). The API rejects anything else at the boundary; the worker treats a
 * row that still slips through as an Internal Error rather than looping on it.
 */
export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}
