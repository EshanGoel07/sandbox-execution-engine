# Spec — Empirical Complexity Analysis

Status: specified, not yet implemented.
Owner: Phase 7 of PLAN.md.

---

## 1. What it does

For an **accepted** submission, run it against generated inputs of increasing size, measure how
its CPU time grows, fit that growth against candidate models, and report a measured complexity
class with a confidence indicator and a chart.

This is only possible because we own the execution layer and can measure CPU time and peak
memory from the cgroup directly. A service built on someone else's judge API cannot do it.

**Honesty requirement, enforced in the UI copy:** this is a *measurement*, not a proof. The
interface says "measured growth: ~O(n²)", never "your solution is O(n²)". Section 8 lists the
caveats that must be documented and surfaced.

## 2. Prerequisite: real resource accounting

Before this works, the runner must report actual resource usage per execution, not just wall
clock. Read from the container's cgroup after the run:

- `cpu.stat` → `usage_usec` — CPU time actually consumed
- `memory.peak` (cgroup v2) → peak resident memory
- fall back to `memory.max_usage_in_bytes` on cgroup v1

**CPU time, not wall time, is the measured quantity.** Wall clock includes scheduler noise,
container startup, and contention from other jobs on the same host; CPU time is far more stable
and is what the growth curve should be fitted against. Wall clock is still recorded and shown,
but it is not the fitting input.

This upgrade also improves normal grading output (real memory numbers instead of estimates),
so it is worth doing regardless.

## 3. Input generators

Complexity analysis requires the ability to produce a *valid* input of arbitrary size n.
That is problem-specific, so each problem opts in:

```sql
ALTER TABLE problems ADD COLUMN generator_language TEXT;   -- null = no analysis support
ALTER TABLE problems ADD COLUMN generator_source   TEXT;
ALTER TABLE problems ADD COLUMN analysis_n_ladder  INTEGER[];  -- optional per-problem override
```

Contract: the generator is a normal program run **in the same sandbox** as everything else.

```
argv: <n> <seed>
stdout: a complete, valid stdin for this problem at size n
```

Rules:
- Generators run under the same isolation as submissions (no network, memory/PID caps, non-root)
- Generators are authored per problem alongside its test cases; a problem without one simply
  does not offer the feature (`supports_complexity_analysis = generator_source IS NOT NULL`)
- Deterministic given `(n, seed)` — the same ladder is reused across submissions to the same
  problem, so generated inputs are cached in Redis/disk by `(problem_id, n, seed)`

## 4. The measurement ladder

Default: `n ∈ {1000, 2000, 4000, 8000, 16000, 32000}` — geometric, not linear.

Geometric spacing is required: fitting is done in log-log space, and evenly-spaced-in-log
points give the regression even leverage across the range. A linear ladder clusters all the
information at the large end.

Per n:
- 1 discarded warm-up run (pays image page-cache and, for the JVM, class-loading costs)
- `k = 5` measured runs
- take the **median** CPU time, not the mean — one preempted run should not move the estimate

Guardrails:
- Total analysis budget: 60s per submission. Exceeded → stop and report what was gathered.
- Per-run time cap: 4× the problem's normal limit. If a run at n exceeds it, stop climbing the
  ladder and report "did not complete at n = X; growth consistent with O(n²) or worse".
- Minimum 4 usable ladder points, else `inconclusive`.
- Compile once, reuse one container for the whole ladder — same design as the grader.

## 5. Fitting

Given points `(n_i, t_i)` where `t_i` is median CPU time:

Candidate models: `1`, `log n`, `n`, `n log n`, `n²`, `n² log n`, `n³`, `2^n`.

For each candidate `f`, fit `t ≈ c · f(n)` by least squares **on log-transformed values**
(log t = log c + log f(n)), then compute R² and RMSE of the residuals. Pick the model with the
best fit.

Also report the raw log-log slope, since for pure power laws `t = c·n^k` the slope *is* k, and
it is a useful sanity check against the chosen model.

Confidence rules:
- `high` — best model's R² ≥ 0.98 **and** its RMSE is meaningfully lower than the runner-up's
- `medium` — R² ≥ 0.95
- `low` / `inconclusive` — otherwise, or when the top two candidates are statistically
  indistinguishable

When `n` and `n log n` fit within noise of each other (the common case), report
**"O(n) or O(n log n)"** rather than picking one. Claiming precision that isn't there is worse
than admitting the limit of the method.

Implementation note: the fitting module is a **pure function** — `(points) => FitResult` — with
no I/O. It is the one genuinely algorithmic piece here, and it should have real unit tests
using synthetic data generated from known curves plus injected noise.

## 6. Job pipeline

Analysis is a **second class of job**, deliberately kept off the grading path.

```
analysis:stream          Redis stream, separate from the submission stream
analysis-workers         own consumer group, own worker process (or own pool in the worker)
```

Why separate rather than reusing the submission queue:
- One analysis is ~30 executions; sharing a queue would let a single analysis request delay
  ordinary grading for everyone
- Different resource profile and different timeout budget
- Lets analysis workers be scaled down (or off) independently without affecting judging

Flow:
1. User clicks "Analyze complexity" on an accepted submission → `POST /app/submissions/:id/analysis`
2. Row inserted in `complexity_results` with `status = 'queued'`; job id pushed to `analysis:stream`
3. Analysis worker: compiles once → for each n → generate (or fetch cached) input → warm-up →
   5 timed runs → record rows
4. Fit, write result, `XACK`
5. Publish progress and completion on the existing Redis Pub/Sub channel so the page updates
   live over the WebSocket that already exists — reuse, do not rebuild

Only accepted submissions are analyzable (analyzing a wrong solution measures nothing useful).
One analysis per submission; results are cached permanently and never recomputed.

## 7. Schema

```sql
complexity_results(
  id, submission_id UNIQUE, status,          -- queued|running|completed|failed|inconclusive
  fitted_model TEXT,                         -- 'n log n'
  exponent NUMERIC,                          -- log-log slope
  r_squared NUMERIC, rmse NUMERIC,
  confidence TEXT,                           -- high|medium|low|inconclusive
  runner_up_model TEXT,
  note TEXT,                                 -- e.g. 'stopped early at n=16000'
  created_at, completed_at
)

complexity_samples(
  id, result_id, n, trial, cpu_time_us, wall_time_ms, peak_memory_kb, ok BOOLEAN
)
```
Keeping every individual sample (not just the median) means the chart can show spread, and the
fit can be re-run later without re-executing anything.

## 8. Documented caveats (must appear in docs AND in the UI)

- Empirical measurement, not a proof of asymptotic complexity
- Small-n behaviour is dominated by constant factors, cache effects, and interpreter startup;
  hence the ladder starts at n = 1000, not n = 10
- `O(n)` and `O(n log n)` are frequently indistinguishable over a 32× range — reported jointly
- JVM warm-up and JIT compilation distort Java timings more than C++ or Python; Java uses a
  longer warm-up and the note field records when JIT effects are suspected
- Measurements are taken on a shared host; contention adds noise, which is why medians of 5
  runs and CPU time (not wall time) are used
- The generator defines what "size n" means for a problem; a badly written generator produces
  a meaningless curve

## 9. Acceptance criteria

- A deliberately O(n²) bubble sort and an O(n log n) std::sort solution to the same problem are
  correctly separated, with `confidence = high` on the quadratic one
- An O(n) solution reports "O(n) or O(n log n)" rather than a confident wrong pick
- Fitting unit tests pass on synthetic curves with 5% injected noise
- A running analysis streams progress to the page over the existing WebSocket
- Analysis jobs never delay ordinary grading (verifiable: submit while an analysis runs)
- Every claim in the UI is hedged as a measurement, per §1
