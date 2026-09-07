/**
 * Milestone 1 regression net: proves the engine still detects MLE / RE and
 * runs correct programs, against real Docker. Behaviour under test is
 * unchanged by the v2 restructure — only the import path moved.
 */
import { judgeSubmission } from "@vj/engine";

interface Case {
  name: string;
  language: "cpp" | "java" | "python";
  source: string;
  stdin: string;
  expectedVerdict: string;
}

const CASES: Case[] = [
  {
    name: "C++ memory bomb",
    language: "cpp",
    source: `
#include <cstring>
#include <vector>
int main() {
    std::vector<char*> hog;
    while (true) {
        char* block = new char[10 * 1024 * 1024];
        memset(block, 1, 10 * 1024 * 1024);
        hog.push_back(block);
    }
    return 0;
}
`,
    stdin: "",
    expectedVerdict: "Memory Limit Exceeded",
  },
  {
    name: "C++ deliberate non-zero exit",
    language: "cpp",
    source: `int main() { return 1; }`,
    stdin: "",
    expectedVerdict: "Runtime Error",
  },
  {
    name: "Java add two numbers",
    language: "java",
    source: `
import java.util.Scanner;
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        System.out.println(sc.nextInt() + sc.nextInt());
    }
}
`,
    stdin: "3 4\n",
    expectedVerdict: "Accepted",
  },
  {
    name: "Python add two numbers",
    language: "python",
    source: `a, b = map(int, input().split())\nprint(a + b)`,
    stdin: "3 4\n",
    expectedVerdict: "Accepted",
  },
];

async function main() {
  let passed = 0;
  for (const c of CASES) {
    console.log(`\n--- ${c.name} ---`);
    const result = await judgeSubmission(c.language, c.source, c.stdin);
    console.log(result);
    const ok = result.verdict === c.expectedVerdict;
    if (ok) passed++;
    console.log(ok ? `PASS (expected ${c.expectedVerdict})` : `FAIL (expected ${c.expectedVerdict}, got ${result.verdict})`);
  }
  console.log(`\n${passed}/${CASES.length} passed`);
  process.exit(passed === CASES.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Suite failed:", err);
  process.exit(1);
});
