/**
 * Convenience for the one-shot case: create a session, compile, run a single
 * input, tear down. Used for ad-hoc "just run this" execution and by the
 * Milestone 1 regression tests.
 */
import type { Language } from "@vj/shared";
import { createSession } from "./session";
import type { CompileOutcome, RunOutcome, RunOptions } from "./outcome";

export interface RunOnceResult {
  compile: CompileOutcome;
  /** null when compilation failed (the program never ran). */
  run: RunOutcome | null;
}

export async function runOnce(
  language: Language,
  sourceCode: string,
  stdin: string,
  opts: RunOptions
): Promise<RunOnceResult> {
  const session = await createSession(language, sourceCode);
  try {
    const compile = await session.compile();
    if (!compile.ok) return { compile, run: null };
    const run = await session.run(stdin, opts);
    return { compile, run };
  } finally {
    await session.close();
  }
}
