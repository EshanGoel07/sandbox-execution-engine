/**
 * The engine's output vocabulary. These are *execution* facts, not grading
 * verdicts: "the program exited non-zero", "the kernel OOM-killed it", "it
 * ran past the wall-clock limit". Mapping these onto a grading `Verdict`
 * (Wrong Answer, Accepted, ...) is the worker's job, not the engine's.
 */
import type { ResourceLimits } from "./container";

/** Result of the compile step. Interpreted languages always report `ok: true`. */
export interface CompileOutcome {
  ok: boolean;
  stderr: string;
  outputTruncated: boolean;
}

/** `outputTruncated`: stdout or stderr passed the per-stream cap and was cut off. */
export type RunOutcome =
  | { kind: "ok"; stdout: string; stderr: string; exitCode: 0; timeMs: number; outputTruncated: boolean }
  | { kind: "runtime_error"; stdout: string; stderr: string; exitCode: number | null; timeMs: number; outputTruncated: boolean }
  | { kind: "out_of_memory"; stdout: string; stderr: string; exitCode: number | null; timeMs: number; outputTruncated: boolean }
  | { kind: "timed_out"; timeMs: number };

export interface RunOptions {
  /** Wall-clock ceiling for a single run. cgroups cap CPU time consumed, not
   *  time elapsed, so a sleeping program still needs this to be killed. */
  wallClockMs: number;
}

/** Fixed for the lifetime of a session (one container). All optional. */
export interface SessionOptions {
  /** Overrides on top of DEFAULT_LIMITS, e.g. a caller-chosen memory ceiling. */
  limits?: Partial<ResourceLimits>;
  /** Wall-clock ceiling for the compile step. Defaults to DEFAULT_COMPILE_TIMEOUT_MS. */
  compileTimeoutMs?: number;
  /** Per-stream output cap. Defaults to DEFAULT_MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}
