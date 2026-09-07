/**
 * HTTP wire contracts shared between the API and the web client.
 *
 * NOTE: some fields are snake_case because the corresponding endpoints
 * currently return raw database rows. That is preserved deliberately so this
 * restructure changes no observable behaviour; normalising the response
 * shapes belongs to the frontend rewrite, not here.
 */
import type { SubmissionStatus, Verdict } from "./verdict";

export interface ProblemListItem {
  id: number;
  title: string;
  testCaseCount: number;
}

/** `GET /problems/:id` — deliberately omits expected outputs (the answer key). */
export interface ProblemDetail {
  id: number;
  title: string;
  statement: string | null;
  timeLimitMs: number;
  testCaseCount: number;
}

/** One per-test row inside a `SubmissionDetail` (raw `submission_results` row). */
export interface TestResult {
  test_case_ordinal: number;
  verdict: Verdict;
  stdout: string | null;
  stderr: string | null;
  time_ms: number | null;
}

/** `GET /submissions/:id` — the submission row plus its per-test results. */
export interface SubmissionDetail {
  id: number;
  problem_id: number;
  language: string;
  status: SubmissionStatus;
  verdict: Verdict | "Not Run (demo)" | null;
  passed_count: number | null;
  total_count: number | null;
  failed_test_ordinal: number | null;
  message: string | null;
  results: TestResult[];
}

/** A submission as listed in profile history and the per-problem tab. */
export interface SubmissionSummary {
  id: number;
  problem_id: number;
  problem_title: string;
  language: string;
  status: SubmissionStatus;
  verdict: string | null;
  passed_count: number | null;
  total_count: number | null;
  created_at: string;
}

export interface AuthUser {
  id: number;
  email: string;
}

export interface PublicUser extends AuthUser {
  created_at: string;
}

/** `POST /auth/signup` and `POST /auth/login`. */
export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface ProfileStats {
  solvedCount: number;
  totalSubmissions: number;
  acceptedSubmissions: number;
  /** accepted / total, in the range 0..1 */
  acceptanceRate: number;
}

/** `GET /profile`. */
export interface Profile {
  user: PublicUser;
  stats: ProfileStats;
  submissions: SubmissionSummary[];
}
