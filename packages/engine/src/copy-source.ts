/**
 * Packages the submission's source code as a tiny in-memory tar archive
 * (Docker's API only accepts file transfers in tar format, not raw files)
 * and extracts it into the container's /sandbox folder.
 */
import * as tar from "tar-stream";
import Docker from "dockerode";

export async function copySourceIntoContainer(
  container: Docker.Container,
  filename: string,
  content: string
): Promise<void> {
  const pack = tar.pack();
  pack.entry({ name: filename }, content);
  pack.finalize();
  await container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: "/sandbox" });
}
