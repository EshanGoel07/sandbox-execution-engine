/**
 * An ExecutionSession is a prepared, single sandbox container you can compile
 * once and then run against many inputs — the "compile once, run many" shape
 * the grader needs, without the engine ever knowing what a "test case" is.
 *
 * Grading stops at the first failure partly because Docker's OOMKilled flag
 * is set at the container level and stays set for the container's lifetime
 * once it fires — so a session must not be reused across an out-of-memory
 * run, or a later fine run could be misread as OOM. The engine surfaces the
 * flag; honouring that rule is the caller's responsibility.
 */
import type Docker from "dockerode";
import type { Language } from "@vj/shared";
import { LANGUAGES } from "./languages";
import { createSandboxContainer } from "./container";
import { copySourceIntoContainer } from "./copy-source";
import { execInContainer } from "./exec";
import { withTimeout, TimeoutError } from "./timeout";
import type { CompileOutcome, RunOutcome, RunOptions } from "./outcome";

export interface ExecutionSession {
  /** Compile the source. No-op (`ok: true`) for interpreted languages. */
  compile(): Promise<CompileOutcome>;
  /** Run the (compiled) program once against `stdin`, bounded by `opts.wallClockMs`. */
  run(stdin: string, opts: RunOptions): Promise<RunOutcome>;
  /** Stop and remove the underlying container. Always call this. */
  close(): Promise<void>;
}

class DockerExecutionSession implements ExecutionSession {
  constructor(
    private readonly container: Docker.Container,
    private readonly lang: (typeof LANGUAGES)[Language]
  ) {}

  async compile(): Promise<CompileOutcome> {
    if (!this.lang.compileCmd) return { ok: true, stderr: "" };
    const result = await execInContainer(this.container, this.lang.compileCmd);
    return { ok: result.exitCode === 0, stderr: result.stderr };
  }

  async run(stdin: string, opts: RunOptions): Promise<RunOutcome> {
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        execInContainer(this.container, this.lang.runCmd, { stdin }),
        opts.wallClockMs
      );
      const timeMs = Date.now() - startedAt;

      if (result.exitCode === 0) {
        return { kind: "ok", stdout: result.stdout, stderr: result.stderr, exitCode: 0, timeMs };
      }

      // Non-zero exit could be an ordinary crash, or the kernel's OOM killer
      // stepping in. Docker tracks that on the container — ask it directly
      // instead of guessing from the exit code.
      const info = await this.container.inspect();
      const kind = info.State.OOMKilled ? "out_of_memory" : "runtime_error";
      return { kind, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timeMs };
    } catch (err) {
      if (err instanceof TimeoutError) {
        return { kind: "timed_out", timeMs: Date.now() - startedAt };
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.container.stop({ t: 1 }).catch(() => {});
    await this.container.remove().catch(() => {});
  }
}

export async function createSession(
  language: Language,
  sourceCode: string
): Promise<ExecutionSession> {
  const lang = LANGUAGES[language];
  if (!lang) throw new Error(`Unknown language: ${language}`);

  const container = await createSandboxContainer(lang.image);
  try {
    await copySourceIntoContainer(container, lang.sourceFilename, sourceCode);
  } catch (err) {
    await container.stop({ t: 1 }).catch(() => {});
    await container.remove().catch(() => {});
    throw err;
  }
  return new DockerExecutionSession(container, lang);
}
