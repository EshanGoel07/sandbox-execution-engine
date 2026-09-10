/**
 * An ExecutionSession is a prepared, single sandbox container you can compile
 * once and then run against many inputs — the "compile once, run many" shape
 * the grader needs, without the engine ever knowing what a "test case" is.
 *
 * Out-of-memory detection reads the kernel's own count of OOM kills in the
 * container's cgroup (cgroup v2 `memory.events`, `oom_kill`) and compares it
 * to the last value this session saw, so each run is judged only on its own
 * kills. Docker's `State.OOMKilled` flag is the wrong source for this: it is
 * set asynchronously from an event stream, so right after an OOM-killed exec
 * returns it is usually still false (measured: 11 of 12 OOM kills misread as
 * plain runtime errors), and once set it stays set for the container's
 * lifetime. It is only used as a fallback on a cgroup-v1 host.
 */
import type Docker from "dockerode";
import type { Language } from "@vj/shared";
import { LANGUAGES } from "./languages";
import { createSandboxContainer, DEFAULT_LIMITS } from "./container";
import { copySourceIntoContainer } from "./copy-source";
import { execInContainer, DEFAULT_MAX_OUTPUT_BYTES } from "./exec";
import { withTimeout, TimeoutError } from "./timeout";
import type { CompileOutcome, RunOutcome, RunOptions, SessionOptions } from "./outcome";

/**
 * Compilation needs a wall-clock ceiling too. Without one, a constexpr loop
 * or a template blow-up can keep g++ busy for minutes — holding a worker
 * slot the whole time, since the run step's timeout never gets a chance to
 * apply. Generous, because javac on a cold JVM under load is slow.
 */
export const DEFAULT_COMPILE_TIMEOUT_MS = 15_000;

// Docker gives each container a private cgroup namespace, so under cgroup v2
// the container's own memory controller files sit at the cgroup root. The
// kernel bumps `oom_kill` synchronously as part of killing a process.
const MEMORY_EVENTS_PATH = "/sys/fs/cgroup/memory.events";

export interface ExecutionSession {
  /** Compile the source. No-op (`ok: true`) for interpreted languages. */
  compile(): Promise<CompileOutcome>;
  /** Run the (compiled) program once against `stdin`, bounded by `opts.wallClockMs`. */
  run(stdin: string, opts: RunOptions): Promise<RunOutcome>;
  /** Stop and remove the underlying container. Always call this. */
  close(): Promise<void>;
}

class DockerExecutionSession implements ExecutionSession {
  /** The cgroup's oom_kill count as of the last check — kills up to here are already attributed. */
  private oomKillsSeen = 0;

  constructor(
    private readonly container: Docker.Container,
    private readonly lang: (typeof LANGUAGES)[Language],
    private readonly compileTimeoutMs: number,
    private readonly maxOutputBytes: number
  ) {}

  async compile(): Promise<CompileOutcome> {
    if (!this.lang.compileCmd) return { ok: true, stderr: "", outputTruncated: false };
    try {
      const result = await withTimeout(
        execInContainer(this.container, this.lang.compileCmd, {
          maxOutputBytes: this.maxOutputBytes,
        }),
        this.compileTimeoutMs
      );
      return {
        ok: result.exitCode === 0,
        stderr: result.stderr,
        outputTruncated: result.outputTruncated,
      };
    } catch (err) {
      // The compiler is still running inside the container; close() kills it.
      if (err instanceof TimeoutError) {
        return {
          ok: false,
          stderr: `Compilation timed out after ${this.compileTimeoutMs}ms.`,
          outputTruncated: false,
        };
      }
      throw err;
    }
  }

  async run(stdin: string, opts: RunOptions): Promise<RunOutcome> {
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        execInContainer(this.container, this.lang.runCmd, {
          stdin,
          maxOutputBytes: this.maxOutputBytes,
        }),
        opts.wallClockMs
      );
      const timeMs = Date.now() - startedAt;
      const { stdout, stderr, outputTruncated } = result;

      if (result.exitCode === 0) {
        return { kind: "ok", stdout, stderr, exitCode: 0, timeMs, outputTruncated };
      }

      // Non-zero exit could be an ordinary crash, or the kernel's OOM killer
      // stepping in. Ask the kernel instead of guessing from the exit code
      // (137 is any SIGKILL, not specifically an OOM kill).
      const kind = (await this.wasOomKilledSinceLastCheck()) ? "out_of_memory" : "runtime_error";
      return { kind, stdout, stderr, exitCode: result.exitCode, timeMs, outputTruncated };
    } catch (err) {
      if (err instanceof TimeoutError) {
        return { kind: "timed_out", timeMs: Date.now() - startedAt };
      }
      throw err;
    }
  }

  private async wasOomKilledSinceLastCheck(): Promise<boolean> {
    let count: number | null = null;
    try {
      const events = await execInContainer(this.container, ["cat", MEMORY_EVENTS_PATH]);
      const match = /^oom_kill (\d+)$/m.exec(events.stdout);
      count = match ? Number(match[1]) : null;
    } catch {
      count = null; // e.g. the OOM killer took PID 1 and the container is gone
    }

    if (count === null) {
      // No cgroup-v2 counter to read: fall back to Docker's (racy, sticky) flag.
      const info = await this.container.inspect();
      return info.State.OOMKilled;
    }
    const killed = count > this.oomKillsSeen;
    this.oomKillsSeen = count;
    return killed;
  }

  async close(): Promise<void> {
    await this.container.stop({ t: 1 }).catch(() => {});
    await this.container.remove().catch(() => {});
  }
}

export async function createSession(
  language: Language,
  sourceCode: string,
  options: SessionOptions = {}
): Promise<ExecutionSession> {
  const lang = LANGUAGES[language];
  if (!lang) throw new Error(`Unknown language: ${language}`);

  const container = await createSandboxContainer(lang.image, {
    ...DEFAULT_LIMITS,
    ...options.limits,
  });
  try {
    await copySourceIntoContainer(container, lang.sourceFilename, sourceCode);
  } catch (err) {
    await container.stop({ t: 1 }).catch(() => {});
    await container.remove().catch(() => {});
    throw err;
  }
  return new DockerExecutionSession(
    container,
    lang,
    options.compileTimeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS,
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  );
}
