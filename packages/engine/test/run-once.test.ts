/**
 * Milestone 1 regression net: a simple correct C++ program compiles and runs
 * to "Accepted" through the engine.
 */
import { judgeSubmission } from "@vj/engine";

const source = `
#include <iostream>
using namespace std;
int main() {
    int a, b;
    cin >> a >> b;
    cout << a + b << endl;
    return 0;
}
`;

async function main() {
  const result = await judgeSubmission("cpp", source, "3 4\n");
  console.log(result);
  const ok = result.verdict === "Accepted" && result.stdout.trim() === "7";
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
