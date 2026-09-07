/**
 * Smoke test: prove this process can talk to the Docker daemon and run a
 * resource-limited container. Not part of `npm test` (it pulls an image) —
 * run directly with `ts-node test/smoke.test.ts` when diagnosing Docker.
 */
import Docker from "dockerode";

async function main() {
  const docker = new Docker();
  const version = await docker.version();
  console.log(`Connected to Docker daemon. Engine version: ${version.Version}`);

  console.log("Pulling alpine:3.20 ...");
  await new Promise<void>((resolve, reject) => {
    docker.pull("alpine:3.20", (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()));
    });
  });

  const output = await docker.run(
    "alpine:3.20",
    ["sh", "-c", "echo hello from inside the sandbox; cat /sys/fs/cgroup/memory.max 2>/dev/null"],
    process.stdout,
    {
      HostConfig: {
        Memory: 64 * 1024 * 1024,
        NetworkMode: "none",
        PidsLimit: 32,
        AutoRemove: true,
      },
    }
  );

  console.log(`\nContainer exited with status code: ${output[0].StatusCode}`);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
