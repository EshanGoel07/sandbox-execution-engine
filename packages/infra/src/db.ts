/**
 * Postgres access. Problems own test cases (input/expected pairs); a
 * submission references a problem and accumulates a status ("Pending" ->
 * "Judging" -> "Done"), an aggregate verdict once judged, and one
 * submission_results row per test case that was actually run.
 *
 * Schema lives in db/migrations/ and is applied by runMigrations() (migrate.ts),
 * never here.
 */
import { Pool } from "pg";
import type {
  GradeResult,
  Profile,
  ProblemDetail,
  ProblemListItem,
  PublicUser,
  SubmissionStatusPayload,
  SubmissionSummary,
} from "@vj/shared";

// Locally there are no env vars and these defaults match a throwaway
// `docker run ... postgres:16-alpine` container — not a secret. In
// docker-compose / on a hosting provider, DATABASE_URL is set (a managed
// provider's URL usually also needs SSL).
export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "disable" ? undefined : { rejectUnauthorized: false },
    })
  : new Pool({
      host: "localhost",
      port: 5432,
      user: "postgres",
      password: "judge",
      database: "judge",
    });

export async function listProblems(): Promise<ProblemListItem[]> {
  const result = await pool.query(
    `SELECT p.id, p.title, COUNT(t.id) AS test_case_count
     FROM problems p LEFT JOIN test_cases t ON t.problem_id = p.id
     GROUP BY p.id ORDER BY p.id`
  );
  return result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    testCaseCount: Number(r.test_case_count),
  }));
}

// DEMO_MODE only: record the submission as finished without ever touching
// the queue or a sandbox container, with a note the UI surfaces verbatim.
export async function markSubmissionDemoDisabled(
  submissionId: number,
  message: string
): Promise<void> {
  await pool.query(
    `UPDATE submissions
     SET status = 'Done', verdict = 'Not Run (demo)', message = $1, judged_at = now()
     WHERE id = $2`,
    [message, submissionId]
  );
}

export interface NewTestCase {
  input: string;
  expectedOutput: string;
}

export interface NewProblem {
  title: string;
  statement?: string;
  timeLimitMs?: number;
  testCases: NewTestCase[];
}

export async function createProblem(input: NewProblem): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const problemResult = await client.query(
      "INSERT INTO problems (title, statement, time_limit_ms) VALUES ($1, $2, $3) RETURNING id",
      [input.title, input.statement ?? null, input.timeLimitMs ?? 5000]
    );
    const problemId = problemResult.rows[0].id;

    for (let i = 0; i < input.testCases.length; i++) {
      const tc = input.testCases[i];
      await client.query(
        "INSERT INTO test_cases (problem_id, ordinal, input, expected_output) VALUES ($1, $2, $3, $4)",
        [problemId, i + 1, tc.input, tc.expectedOutput]
      );
    }

    await client.query("COMMIT");
    return problemId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Deliberately omits expected_output — a real client asking "what is this
// problem" shouldn't get the answer key back in the response.
export async function getProblemPublic(problemId: number): Promise<ProblemDetail | null> {
  const result = await pool.query(
    `SELECT p.id, p.title, p.statement, p.time_limit_ms, COUNT(t.id) AS test_case_count
     FROM problems p LEFT JOIN test_cases t ON t.problem_id = p.id
     WHERE p.id = $1
     GROUP BY p.id`,
    [problemId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    title: row.title,
    statement: row.statement,
    timeLimitMs: row.time_limit_ms,
    testCaseCount: Number(row.test_case_count),
  };
}

export async function createSubmission(input: {
  problemId: number;
  language: string;
  sourceCode: string;
  stdin?: string;
  userId?: number;
}): Promise<number> {
  const result = await pool.query(
    "INSERT INTO submissions (problem_id, language, source_code, stdin, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [input.problemId, input.language, input.sourceCode, input.stdin ?? null, input.userId ?? null]
  );
  return result.rows[0].id;
}

// --- users -------------------------------------------------------------------

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: string;
}

export async function createUser(email: string, passwordHash: string): Promise<PublicUser> {
  const result = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
    [email.trim().toLowerCase(), passwordHash]
  );
  return result.rows[0];
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [
    email.trim().toLowerCase(),
  ]);
  return result.rows[0] ?? null;
}

export async function getUserById(id: number): Promise<PublicUser | null> {
  const result = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id = $1",
    [id]
  );
  return result.rows[0] ?? null;
}

// --- per-user submission views --------------------------------------------

const SUBMISSION_SUMMARY_SELECT = `
  SELECT s.id, s.problem_id, p.title AS problem_title, s.language, s.status,
         s.verdict, s.passed_count, s.total_count, s.created_at
  FROM submissions s JOIN problems p ON p.id = s.problem_id`;

export async function getUserSubmissionsForProblem(
  userId: number,
  problemId: number
): Promise<SubmissionSummary[]> {
  const result = await pool.query(
    `${SUBMISSION_SUMMARY_SELECT}
     WHERE s.user_id = $1 AND s.problem_id = $2
     ORDER BY s.id DESC`,
    [userId, problemId]
  );
  return result.rows;
}

export async function getUserProfile(userId: number): Promise<Profile | null> {
  const user = await getUserById(userId);
  if (!user) return null;

  const statsResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE verdict = 'Accepted')                  AS accepted,
       COUNT(*)                                                      AS total,
       COUNT(DISTINCT problem_id) FILTER (WHERE verdict = 'Accepted') AS solved
     FROM submissions WHERE user_id = $1`,
    [userId]
  );
  const row = statsResult.rows[0];
  const accepted = Number(row.accepted);
  const total = Number(row.total);

  const submissionsResult = await pool.query(
    `${SUBMISSION_SUMMARY_SELECT}
     WHERE s.user_id = $1
     ORDER BY s.id DESC
     LIMIT 100`,
    [userId]
  );

  return {
    user,
    stats: {
      solvedCount: Number(row.solved),
      totalSubmissions: total,
      acceptedSubmissions: accepted,
      acceptanceRate: total > 0 ? accepted / total : 0,
    },
    submissions: submissionsResult.rows,
  };
}

export interface SubmissionForGrading {
  language: string;
  sourceCode: string;
  timeLimitMs: number;
  testCases: { ordinal: number; input: string; expectedOutput: string }[];
}

export async function getSubmissionForGrading(
  submissionId: number
): Promise<SubmissionForGrading | null> {
  const submissionResult = await pool.query(
    `SELECT s.language, s.source_code, s.problem_id, p.time_limit_ms
     FROM submissions s JOIN problems p ON p.id = s.problem_id
     WHERE s.id = $1`,
    [submissionId]
  );
  if (submissionResult.rows.length === 0) return null;
  const row = submissionResult.rows[0];

  const testCasesResult = await pool.query(
    "SELECT ordinal, input, expected_output FROM test_cases WHERE problem_id = $1 ORDER BY ordinal",
    [row.problem_id]
  );

  return {
    language: row.language,
    sourceCode: row.source_code,
    timeLimitMs: row.time_limit_ms,
    testCases: testCasesResult.rows.map((r) => ({
      ordinal: r.ordinal,
      input: r.input,
      expectedOutput: r.expected_output,
    })),
  };
}

export async function updateSubmissionStatus(submissionId: number, status: string): Promise<void> {
  await pool.query("UPDATE submissions SET status = $1 WHERE id = $2", [status, submissionId]);
}

// Used to catch a WebSocket subscriber up to the current state the instant it
// subscribes — a client can easily subscribe after the worker has already
// published an update (or finished grading), and would otherwise wait forever.
export async function getSubmissionStatus(
  submissionId: number
): Promise<SubmissionStatusPayload | null> {
  const result = await pool.query(
    "SELECT id, status, verdict, passed_count, total_count, failed_test_ordinal, message FROM submissions WHERE id = $1",
    [submissionId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    submissionId: row.id,
    status: row.status,
    verdict: row.verdict,
    passedCount: row.passed_count,
    totalCount: row.total_count,
    failedOrdinal: row.failed_test_ordinal,
    message: row.message,
  };
}

export async function saveGradeResult(submissionId: number, gradeResult: GradeResult): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE submissions
       SET status = 'Done', verdict = $1, passed_count = $2, total_count = $3,
           failed_test_ordinal = $4, judged_at = now()
       WHERE id = $5`,
      [
        gradeResult.verdict,
        gradeResult.passedCount,
        gradeResult.totalCount,
        gradeResult.failedOrdinal,
        submissionId,
      ]
    );

    for (const testResult of gradeResult.results) {
      await client.query(
        `INSERT INTO submission_results
           (submission_id, test_case_ordinal, verdict, stdout, stderr, time_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          submissionId,
          testResult.ordinal,
          testResult.verdict,
          testResult.stdout,
          testResult.stderr,
          testResult.timeMs,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getSubmissionWithResults(submissionId: number) {
  const submissionResult = await pool.query("SELECT * FROM submissions WHERE id = $1", [submissionId]);
  if (submissionResult.rows.length === 0) return null;

  const resultsResult = await pool.query(
    "SELECT test_case_ordinal, verdict, stdout, stderr, time_ms FROM submission_results WHERE submission_id = $1 ORDER BY test_case_ordinal",
    [submissionId]
  );

  return { ...submissionResult.rows[0], results: resultsResult.rows };
}
