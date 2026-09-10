export { createSession, DEFAULT_COMPILE_TIMEOUT_MS } from "./session";
export type { ExecutionSession } from "./session";
export { runOnce } from "./run-once";
export type { RunOnceResult } from "./run-once";
export type { CompileOutcome, RunOutcome, RunOptions, SessionOptions } from "./outcome";
export { DEFAULT_LIMITS } from "./container";
export type { ResourceLimits } from "./container";
export { DEFAULT_MAX_OUTPUT_BYTES } from "./exec";
export { TimeoutError } from "./timeout";
export type { LanguageConfig } from "./languages";

// Deprecated one-shot shim — kept for the Milestone 1 regression tests only.
export { judgeSubmission } from "./judge";
export type { JudgeResult } from "./judge";
