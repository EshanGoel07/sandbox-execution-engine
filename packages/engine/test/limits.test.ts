/**
 * The per-session knobs the public execution API relies on, against real
 * Docker:
 *   - a caller-chosen memory ceiling is actually enforced (and only that one:
 *     the same program passes under the default ceiling)
 *   - output past the cap is cut off and flagged, not buffered without bound
 *   - a compile that runs past its wall-clock ceiling is stopped
 */
import { runOnce } from "@vj/engine";

const MB = 1024 * 1024;

// Touches every byte of ~100 MB (bytes * n writes the whole buffer, so the
// pages are really resident — not just reserved).
const ALLOC_100MB = `x = b"a" * (100 * 1024 * 1024)\nprint(len(x))`;

// 3 MiB to stdout, then a clean exit.
const FLOOD_3MB = `import sys\nsys.stdout.write("x" * (3 * 1024 * 1024))`;

// g++ caps each constant evaluation (-fconstexpr-ops-limit), so one huge
// constexpr loop just errors out quickly. 400 separate evaluations, each
// under the cap, add up to well over 20s of g++ CPU (measured).
const SLOW_COMPILE = `
template <int K>
constexpr long long spin() {
  long long s = 0;
  for (int i = 0; i < 1500; ++i)
    for (int j = 0; j < 1500; ++j) s += (i ^ j) + K;
  return s;
}
template <int K> struct S { static constexpr long long v = spin<K>() + S<K - 1>::v; };
template <> struct S<0> { static constexpr long long v = 0; };
int main() { return S<400>::v & 1; }
`;

async function main() {
  let passed = 0;
  let total = 0;
  const check = (name: string, ok: boolean, detail: unknown) => {
    total++;
    if (ok) passed++;
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}`, ok ? "" : detail);
  };

  // Repeated: OOM classification used to be a race against Docker's event
  // stream and passed only occasionally. One lucky pass proves nothing.
  const oomKinds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const small = await runOnce("python", ALLOC_100MB, "", { wallClockMs: 10000 }, {
      limits: { memoryBytes: 64 * MB },
    });
    oomKinds.push(String(small.run?.kind));
  }
  check(
    "100 MB allocation under a 64 MB limit is out_of_memory (5 of 5)",
    oomKinds.every((k) => k === "out_of_memory"),
    oomKinds
  );

  const roomy = await runOnce("python", ALLOC_100MB, "", { wallClockMs: 10000 });
  check("same allocation under the 256 MB default runs ok", roomy.run?.kind === "ok", roomy.run);

  const flood = await runOnce("python", FLOOD_3MB, "", { wallClockMs: 10000 });
  const floodRun = flood.run;
  check(
    "3 MiB of stdout is truncated to 1 MiB and flagged",
    floodRun?.kind === "ok" && floodRun.stdout.length === 1 * MB && floodRun.outputTruncated,
    floodRun && floodRun.kind !== "timed_out"
      ? { kind: floodRun.kind, length: floodRun.stdout.length, truncated: floodRun.outputTruncated }
      : floodRun
  );

  const startedAt = Date.now();
  const slow = await runOnce("cpp", SLOW_COMPILE, "", { wallClockMs: 5000 }, { compileTimeoutMs: 2000 });
  const elapsed = Date.now() - startedAt;
  check(
    "a compile past its ceiling is stopped and reported as a failed compile",
    !slow.compile.ok && /timed out/i.test(slow.compile.stderr) && elapsed < 10000,
    { compile: slow.compile, elapsed }
  );

  console.log(`\n${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Suite failed:", err);
  process.exit(1);
});
