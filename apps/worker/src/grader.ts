/**
 * Grades one submission against many test cases: compile once, then run the
 * program once per test case, comparing output. Grading stops at the first
 * non-Accepted case — matching how real judges behave, saving compute, and
 * avoiding a trap: Docker's OOMKilled flag stays set for a container's
 * lifetime once it fires, so a session must not be reused past an MLE.
 *
 * All container mechanics live in @vj/engine. This file is pure grading:
 * turn an execution `RunOutcome` plus an expected-output comparison into a
 * `Verdict`.
 */
import { createSession } from "@vj/engine";
import type { GradeResult, Language, TestCaseInput, TestCaseResult, Verdict } from "@vj/shared";

// Exact-match comparison is the norm for simple judges, but naive string
// equality would fail submissions over a trailing newline or trailing spaces
// a human wouldn't call "wrong" — so trim those before comparing.
function normalizeOutput(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

export async function gradeSubmission(
  language: Language,
  sourceCode: string,
  testCases: TestCaseInput[],
  timeLimitMs: number
): Promise<GradeResult> {
  const session = await createSession(language, sourceCode);
  const results: TestCaseResult[] = [];

  try {
    const compiled = await session.compile();
    if (!compiled.ok) {
      return {
        verdict: "Compile Error",
        passedCount: 0,
        totalCount: testCases.length,
        failedOrdinal: testCases[0]?.ordinal ?? null,
        results: [],
      };
    }

    for (const testCase of testCases) {
      const outcome = await session.run(testCase.input, { wallClockMs: timeLimitMs });

      let verdict: Verdict;
      let stdout = "";
      let stderr = "";

      switch (outcome.kind) {
        case "timed_out":
          verdict = "Time Limit Exceeded";
          break;
        case "out_of_memory":
          verdict = "Memory Limit Exceeded";
          stdout = outcome.stdout;
          stderr = outcome.stderr;
          break;
        case "runtime_error":
          verdict = "Runtime Error";
          stdout = outcome.stdout;
          stderr = outcome.stderr;
          break;
        case "ok":
          stdout = outcome.stdout;
          stderr = outcome.stderr;
          verdict =
            normalizeOutput(stdout) === normalizeOutput(testCase.expectedOutput)
              ? "Accepted"
              : "Wrong Answer";
          break;
      }

      // `outcome.timeMs` is measured elapsed for every kind, including a
      // timeout — matching v1's `Date.now() - startedAt`.
      results.push({ ordinal: testCase.ordinal, verdict, stdout, stderr, timeMs: outcome.timeMs });

      if (verdict !== "Accepted") {
        return {
          verdict,
          passedCount: results.length - 1,
          totalCount: testCases.length,
          failedOrdinal: testCase.ordinal,
          results,
        };
      }
    }

    return {
      verdict: "Accepted",
      passedCount: testCases.length,
      totalCount: testCases.length,
      failedOrdinal: null,
      results,
    };
  } finally {
    await session.close();
  }
}
