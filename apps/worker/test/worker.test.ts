import {
  runMigrations,
  createProblem,
  createSubmission,
  enqueueSubmission,
  closeStream,
  pendingCount,
} from "@vj/infra";
import { WorkerPool, SubmissionOutcome } from "@vj/worker";

const SUBMISSIONS = [
  { language: "cpp", sourceCode: `#include <iostream>
int main() { int a, b; std::cin >> a >> b; std::cout << a + b; }`, input: "3 4", expected: "7" },
  { language: "python", sourceCode: `a, b = map(int, input().split())
print(a + b)`, input: "5 6", expected: "11" },
  { language: "java", sourceCode: `import java.util.Scanner;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    System.out.print(sc.nextInt() + sc.nextInt());
  }
}`, input: "10 20", expected: "30" },
  { language: "cpp", sourceCode: `#include <iostream>
int main() { int a, b; std::cin >> a >> b; std::cout << a + b; }`, input: "100 200", expected: "300" },
  { language: "python", sourceCode: `a, b = map(int, input().split())
print(a + b)`, input: "1 1", expected: "2" },
  { language: "java", sourceCode: `import java.util.Scanner;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    System.out.print(sc.nextInt() + sc.nextInt());
  }
}`, input: "7 8", expected: "15" },
];

async function main() {
  await runMigrations();

  const expectedById = new Map<number, string>();
  for (const sub of SUBMISSIONS) {
    const problemId = await createProblem({
      title: `worker concurrency smoke test (${sub.language})`,
      testCases: [{ input: sub.input, expectedOutput: sub.expected }],
    });
    const submissionId = await createSubmission({
      problemId,
      language: sub.language,
      sourceCode: sub.sourceCode,
    });
    await enqueueSubmission(submissionId);
    expectedById.set(submissionId, sub.expected);
  }
  console.log(`enqueued ${expectedById.size} submissions`);

  const outcomes: SubmissionOutcome[] = [];
  const consumersUsed = new Set<string>();
  const startedAt = Date.now();

  const pool = new WorkerPool({
    count: 3,
    waitMs: 1000,
    onResult: (outcome, consumerName) => {
      consumersUsed.add(consumerName);
      outcomes.push(outcome);
      console.log(
        `[${consumerName}] submission ${outcome.submissionId} -> ${outcome.gradeResult.verdict} ` +
          `(${outcome.gradeResult.passedCount}/${outcome.gradeResult.totalCount}) (+${Date.now() - startedAt}ms)`
      );
    },
  });
  pool.start();

  while (outcomes.length < expectedById.size) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const totalMs = Date.now() - startedAt;

  await pool.stop();

  let allPass = true;
  for (const outcome of outcomes) {
    const ok = outcome.gradeResult.verdict === "Accepted" && expectedById.has(outcome.submissionId);
    if (!ok) {
      console.log(`FAIL: submission ${outcome.submissionId} got verdict=${outcome.gradeResult.verdict}`);
      allPass = false;
    }
  }

  const pending = await pendingCount();
  console.log(`consumers that did work: ${consumersUsed.size} of 3`);
  console.log(`total wall time: ${totalMs}ms for ${outcomes.length} jobs`);
  console.log(`pending (unacked) count after run: ${pending}`);

  if (consumersUsed.size < 2) {
    console.log("FAIL: expected work spread across multiple consumers");
    allPass = false;
  }
  if (pending !== 0) {
    console.log("FAIL: expected all messages acked");
    allPass = false;
  }

  console.log(allPass ? "PASS" : "FAIL");
  if (!allPass) process.exitCode = 1;

  await closeStream();
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
