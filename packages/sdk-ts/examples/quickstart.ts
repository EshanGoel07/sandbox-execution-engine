/**
 * The README's SDK quickstart, runnable:
 *
 *   npm run build
 *   VJ_API_KEY=vj_live_... npm run example -w @vj/sdk
 *
 * VJ_BASE_URL defaults to the local docker-compose stack.
 */
import { VirtualJudge, VirtualJudgeError } from "@vj/sdk";

async function main() {
  const vj = new VirtualJudge({
    apiKey: process.env.VJ_API_KEY ?? "",
    baseUrl: process.env.VJ_BASE_URL ?? "http://localhost:3000",
  });

  const execution = await vj.run(
    {
      language: "python",
      source_code: "a, b = map(int, input().split())\nprint(a + b)",
      stdin: "3 4\n",
      limits: { time_ms: 2000, memory_mb: 128 },
    },
    { onPoll: (e) => console.log(`status: ${e.status}`) }
  );

  console.log(`outcome: ${execution.result?.outcome}`);
  console.log(`stdout:  ${JSON.stringify(execution.result?.stdout)}`);
  console.log(`time:    ${execution.result?.wall_time_ms} ms`);
}

main().catch((err) => {
  if (err instanceof VirtualJudgeError) {
    console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
