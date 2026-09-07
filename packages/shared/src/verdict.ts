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
  | "Memory Limit Exceeded";

/** Lifecycle of a submission row, independent of its eventual verdict. */
export type SubmissionStatus = "Pending" | "Judging" | "Done";

/** Languages the judge can compile and run. */
export type Language = "cpp" | "java" | "python";
