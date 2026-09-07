/**
 * Runs one command inside an already-running container (compiling, or
 * executing the compiled program), optionally feeding it stdin, and
 * captures everything it printed plus its exit code.
 */
import Docker from "dockerode";
import { Writable } from "stream";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function execInContainer(
  container: Docker.Container,
  cmd: string[],
  options: { stdin?: string; workingDir?: string } = {}
): Promise<ExecResult> {
  const wantsStdin = options.stdin !== undefined;

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
  let stdout = "";
  let stderr = "";
  const stdoutSink = new Writable({
    write(chunk, _enc, cb) {
      stdout += chunk.toString();
      cb();
    },
  });
  const stderrSink = new Writable({
    write(chunk, _enc, cb) {
      stderr += chunk.toString();
      cb();
    },
  });
  container.modem.demuxStream(stream, stdoutSink, stderrSink);

  if (wantsStdin) {
    stream.write(options.stdin);
    stream.end();
  }

  await new Promise<void>((resolve) => stream.on("end", resolve));

  const info = await exec.inspect();
  return { stdout, stderr, exitCode: info.ExitCode };
}
