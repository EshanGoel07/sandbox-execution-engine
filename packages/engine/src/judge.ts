/**
 * @deprecated Compatibility shim.
 *
 * `judgeSubmission` predates the split of execution from grading. It now does
 * nothing but call `runOnce` and translate the engine's `RunOutcome` back
 * into the old flat `JudgeResult`. It is kept ONLY so the Milestone 1
 * regression tests (which prove TLE / MLE / RE detection still works against
 * real Docker) run unchanged through this refactor.
 *
 * Phase 5: delete this file and re-point those tests at `runOnce` /
 * `createSession` directly.
 */
import type { Language } from "@vj/shared";
import { runOnce } from "./run-once";

const TIME_LIMIT_MS = 5000;

export interface JudgeResult {
  verdict:
    | "Accepted"
    | "Compile Error"
    | "Runtime Error"
    | "Time Limit Exceeded"
    | "Memory Limit Exceeded";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timeMs: number;
}

export async function judgeSubmission(
  language: Language,
  sourceCode: string,
  stdin: string
): Promise<JudgeResult> {
  const { compile, run } = await runOnce(language, sourceCode, stdin, {
    wallClockMs: TIME_LIMIT_MS,
  });

  if (!compile.ok || run === null) {
    return { verdict: "Compile Error", stdout: "", stderr: compile.stderr, exitCode: null, timeMs: 0 };
  }

  switch (run.kind) {
    case "ok":
      return { verdict: "Accepted", stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, timeMs: run.timeMs };
    case "out_of_memory":
      return { verdict: "Memory Limit Exceeded", stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, timeMs: run.timeMs };
    case "runtime_error":
      return { verdict: "Runtime Error", stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, timeMs: run.timeMs };
    case "timed_out":
      return { verdict: "Time Limit Exceeded", stdout: "", stderr: "", exitCode: null, timeMs: TIME_LIMIT_MS };
  }
}
