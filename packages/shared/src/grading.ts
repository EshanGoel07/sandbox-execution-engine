import type { Verdict } from "./verdict";

/** One test case as handed to the grader: what to feed in, what to expect out. */
export interface TestCaseInput {
  ordinal: number;
  input: string;
  expectedOutput: string;
}

/** The grader's result for a single test case that was actually run. */
export interface TestCaseResult {
  ordinal: number;
  verdict: Verdict;
  stdout: string;
  stderr: string;
  timeMs: number;
}

/**
 * Aggregate result of grading one submission against its test cases.
 * `results` only contains the cases that ran — grading stops at the first
 * non-Accepted case, so on failure `results.length < totalCount`.
 */
export interface GradeResult {
  verdict: Verdict;
  passedCount: number;
  totalCount: number;
  failedOrdinal: number | null;
  results: TestCaseResult[];
}
