/**
 * Runs one command inside an already-running container (compiling, or
 * executing the compiled program), optionally feeding it stdin, and
 * captures everything it printed plus its exit code.
 */
import Docker from "dockerode";
import { Writable } from "stream";

/**
 * Per-stream cap on captured output. Without one, `while (1) print("x")`
 * streams hundreds of MB/s into the WORKER's heap for the whole wall-clock
 * window — enough to OOM-kill the worker process and every consumer in it.
 * Far above any real program's output.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if stdout or stderr went past the cap and was cut off. */
  outputTruncated: boolean;
}

/**
 * Keeps the first `limit` bytes and discards the rest while still consuming
 * the stream — so memory stays bounded, the program never blocks on a full
 * pipe, and the wall-clock limit is what ends a runaway writer.
 *
 * Buffers are joined and decoded once at the end: decoding chunk by chunk
 * would corrupt a multi-byte UTF-8 character split across two chunks.
 */
class CappedSink extends Writable {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {
    super();
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    const room = this.limit - this.size;
    if (room > 0) {
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.chunks.push(kept);
      this.size += kept.length;
    }
    if (chunk.length > room) this.truncated = true;
    cb();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export async function execInContainer(
  container: Docker.Container,
  cmd: string[],
  options: { stdin?: string; workingDir?: string; maxOutputBytes?: number } = {}
): Promise<ExecResult> {
  const wantsStdin = options.stdin !== undefined;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: options.workingDir ?? "/sandbox",
    AttachStdin: wantsStdin,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: wantsStdin, stdin: wantsStdin });

  // Docker sends stdout and stderr interleaved on this ONE stream (no pseudo-
  // terminal requested), each chunk tagged with a small header saying which
  // one it is. demuxStream reads those headers and splits it back into two.
  const stdoutSink = new CappedSink(maxOutputBytes);
  const stderrSink = new CappedSink(maxOutputBytes);
  container.modem.demuxStream(stream, stdoutSink, stderrSink);

  if (wantsStdin) {
    stream.write(options.stdin);
    stream.end();
  }

  await new Promise<void>((resolve) => stream.on("end", resolve));

  const info = await exec.inspect();
  return {
    stdout: stdoutSink.text(),
    stderr: stderrSink.text(),
    exitCode: info.ExitCode,
    outputTruncated: stdoutSink.truncated || stderrSink.truncated,
  };
}
