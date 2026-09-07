import {
  runMigrations,
  createProblem,
  createSubmission,
  enqueueSubmission,
  createConsumerConnection,
  closeStream,
} from "@vj/infra";
import { processOneSubmission } from "@vj/worker";

async function main() {
  await runMigrations();

  const problemId = await createProblem({
    title: "Add Two Numbers (queue smoke test)",
    testCases: [{ input: "3 4", expectedOutput: "7" }],
  });

  const submissionId = await createSubmission({
    problemId,
    language: "cpp",
    sourceCode: `#include <iostream>
int main() { int a, b; std::cin >> a >> b; std::cout << a + b; }`,
  });

  const id = await enqueueSubmission(submissionId);
  console.log("enqueued:", id);

  const client = createConsumerConnection();
  const outcome = await processOneSubmission("worker-1", 5000, client);
  if (!outcome) {
    console.log("FAIL: no message received");
    process.exitCode = 1;
  } else {
    console.log("processed message:", outcome.id, "verdict:", outcome.gradeResult.verdict);
    const ok =
      outcome.gradeResult.verdict === "Accepted" &&
      outcome.gradeResult.passedCount === 1 &&
      outcome.gradeResult.totalCount === 1;
    console.log(ok ? "PASS" : "FAIL");
    if (!ok) process.exitCode = 1;
  }

  await client.quit();
  await closeStream();
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
