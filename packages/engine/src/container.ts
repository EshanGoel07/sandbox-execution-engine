/**
 * Creates and starts a fresh, resource-limited sandbox container from one
 * of our language images (judge-cpp, judge-java, judge-python).
 *
 * This does NOT run the submission yet — it just gets an empty, locked-down
 * box up and running so that a later step can copy the submission's code
 * in and exec the compile/run commands inside it.
 */
import Docker from "dockerode";

const docker = new Docker();

export interface ResourceLimits {
  memoryBytes: number;
  pidsLimit: number;
}

export const DEFAULT_LIMITS: ResourceLimits = {
  memoryBytes: 256 * 1024 * 1024, // 256MB — generous enough for real submissions,
  pidsLimit: 64,                  // still far below "let it eat the whole machine"
};

export async function createSandboxContainer(
  image: string,
  limits: ResourceLimits = DEFAULT_LIMITS
): Promise<Docker.Container> {
  // The judge needs two steps in the SAME container: compile, then run (so
  // the compiled binary from step 1 is still there for step 2). A container
  // normally exits the instant its one command finishes, so we start it with
  // a command that never finishes ("sleep infinity") and drive it with exec.
  const container = await docker.createContainer({
    Image: image,
    Cmd: ["sleep", "infinity"],
    HostConfig: {
      Memory: limits.memoryBytes,
      // Memory+swap ceiling, set equal to Memory => zero swap. Left unset,
      // Docker lets a container ALSO use swap equal to its memory limit on a
      // host that has swap (Docker Desktop's VM does), so a "256 MB" box
      // could really hold 512 MB. The limit is a public contract now, so it
      // has to mean what it says.
      MemorySwap: limits.memoryBytes,
      NetworkMode: "none",
      PidsLimit: limits.pidsLimit,
    },
    Tty: false,
  });

  await container.start();
  return container;
}
