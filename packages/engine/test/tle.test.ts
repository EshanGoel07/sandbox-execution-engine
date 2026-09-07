/**
 * Milestone 1 regression net: a deliberate infinite loop is killed by the
 * wall-clock limit and reported as Time Limit Exceeded (not left hanging).
 */
import { judgeSubmission } from "@vj/engine";

const infiniteLoop = `int main() { while (true) {} }`;

async function main() {
  const startedAt = Date.now();
  const result = await judgeSubmission("cpp", infiniteLoop, "");
  const elapsed = Date.now() - startedAt;
  console.log(result);
  console.log(`wall-clock time for the whole test: ${elapsed}ms`);
  const ok = result.verdict === "Time Limit Exceeded" && elapsed < 15000;
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
