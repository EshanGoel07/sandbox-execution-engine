/**
 * The engine's output vocabulary. These are *execution* facts, not grading
 * verdicts: "the program exited non-zero", "the kernel OOM-killed it", "it
 * ran past the wall-clock limit". Mapping these onto a grading `Verdict`
 * (Wrong Answer, Accepted, ...) is the worker's job, not the engine's.
 */

/** Result of the compile step. Interpreted languages always report `ok: true`. */
export interface CompileOutcome {
  ok: boolean;
  stderr: string;
}

export type RunOutcome =
  | { kind: "ok"; stdout: string; stderr: string; exitCode: 0; timeMs: number }
  | { kind: "runtime_error"; stdout: string; stderr: string; exitCode: number | null; timeMs: number }
  | { kind: "out_of_memory"; stdout: string; stderr: string; exitCode: number | null; timeMs: number }
  | { kind: "timed_out"; timeMs: number };

export interface RunOptions {
  /** Wall-clock ceiling for a single run. cgroups cap CPU time consumed, not
   *  time elapsed, so a sleeping program still needs this to be killed. */
  wallClockMs: number;
}
