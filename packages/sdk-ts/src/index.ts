/**
 * Typed client for the Virtual Judge execution API.
 *
 *   const vj = new VirtualJudge({ apiKey: process.env.VJ_API_KEY! });
 *   const execution = await vj.run({ language: "python", source_code: "print(1 + 1)" });
 *   execution.result?.stdout; // "2\n"
 *
 * Every type here is generated from openapi.yaml (src/generated/openapi.ts),
 * so the SDK cannot drift from the documented API: change the spec and the
 * SDK's types change with it, or the build breaks.
 *
 * Zero runtime dependencies — it only needs the platform `fetch`.
 */
import type { components } from "./generated/openapi";

type Schemas = components["schemas"];
export type Language = Schemas["Language"];
export type LanguageId = Schemas["LanguageId"];
export type CreateExecutionRequest = Schemas["CreateExecutionRequest"];
export type ExecutionCreated = Schemas["ExecutionCreated"];
export type Execution = Schemas["Execution"];
export type ExecutionResult = Schemas["ExecutionResult"];
export type ExecutionStatus = Schemas["ExecutionStatus"];
export type ExecutionOutcome = Schemas["ExecutionOutcome"];
export type Limits = Schemas["Limits"];
export type ErrorCode = Schemas["ErrorCode"];

/** An error response from the API, carrying its stable `code`. */
export class VirtualJudgeError extends Error {
  constructor(
    /** HTTP status. */
    readonly status: number,
    /** The API's machine-readable code, or "unexpected_response" if the body wasn't the error envelope. */
    readonly code: ErrorCode | "unexpected_response",
    message: string,
    /** From Retry-After, on 429s. */
    readonly retryAfterSeconds: number | null
  ) {
    super(message);
    this.name = "VirtualJudgeError";
  }
}

/** waitFor gave up before the execution finished. The execution itself is unaffected. */
export class WaitTimeoutError extends Error {
  constructor(
    readonly executionId: string,
    readonly timeoutMs: number,
    /** The last state seen, if any poll succeeded. */
    readonly lastSeen: Execution | null
  ) {
    super(`Execution ${executionId} did not finish within ${timeoutMs}ms.`);
    this.name = "WaitTimeoutError";
  }
}

export interface VirtualJudgeOptions {
  apiKey: string;
  /** Default: http://localhost:3000 (the docker-compose stack). */
  baseUrl?: string;
  /** Inject a fetch implementation (tests, older runtimes). Default: global fetch. */
  fetch?: typeof fetch;
}

export interface WaitOptions {
  /** Give up after this long. Default 60 000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with every polled state, e.g. to show queued → running → completed. */
  onPoll?: (execution: Execution) => void;
}

// Polling schedule for waitFor: start fast (most executions finish in a
// second or two), then back off. The ceiling is tied to the default limits:
// at one poll per 2 s, even the maximum 3 concurrent executions per account
// being waited on cost 90 requests/min — inside the 120/min rate limit, so
// the SDK's own polling can't be what gets a client throttled.
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 2000;
const BACKOFF = 1.5;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class VirtualJudge {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VirtualJudgeOptions) {
    if (!options.apiKey) throw new Error("VirtualJudge: apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Supported languages. */
  async listLanguages(): Promise<Language[]> {
    const list = await this.request<Schemas["LanguageList"]>("GET", "/api/v1/languages");
    return list.data;
  }

  /** Queue code for execution. Resolves as soon as it is queued (202), not when it finishes. */
  createExecution(request: CreateExecutionRequest, signal?: AbortSignal): Promise<ExecutionCreated> {
    return this.request<ExecutionCreated>("POST", "/api/v1/executions", request, signal);
  }

  /** Current state of an execution. `result` is null until status is "completed". */
  getExecution(id: string, signal?: AbortSignal): Promise<Execution> {
    return this.request<Execution>("GET", `/api/v1/executions/${encodeURIComponent(id)}`, undefined, signal);
  }

  /**
   * Polls until the execution is terminal ("completed" or "failed").
   *
   * This is client-side on purpose: the server never holds a request open
   * waiting for code to run, which is what keeps API latency independent of
   * how long programs take. If a poll is rate-limited, waitFor sleeps for
   * the server's Retry-After and carries on.
   */
  async waitFor(id: string, options: WaitOptions = {}): Promise<Execution> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    let delay = FIRST_POLL_MS;
    let lastSeen: Execution | null = null;

    for (;;) {
      let pause = delay;
      try {
        const execution = await this.getExecution(id, options.signal);
        lastSeen = execution;
        options.onPoll?.(execution);
        if (execution.status === "completed" || execution.status === "failed") return execution;
        delay = Math.min(MAX_POLL_MS, Math.round(delay * BACKOFF));
      } catch (err) {
        if (!(err instanceof VirtualJudgeError && err.code === "rate_limited")) throw err;
        pause = (err.retryAfterSeconds ?? 1) * 1000;
      }
      if (Date.now() + pause > deadline) throw new WaitTimeoutError(id, timeoutMs, lastSeen);
      await sleep(pause, options.signal);
    }
  }

  /** createExecution + waitFor, for when you just want the result. */
  async run(request: CreateExecutionRequest, options: WaitOptions = {}): Promise<Execution> {
    const { id } = await this.createExecution(request, options.signal);
    return this.waitFor(id, options);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const envelope = (parsed as { error?: { code?: ErrorCode; message?: string } } | null)?.error;
      const retryAfter = res.headers.get("retry-after");
      throw new VirtualJudgeError(
        res.status,
        envelope?.code ?? "unexpected_response",
        envelope?.message ?? `HTTP ${res.status}`,
        retryAfter === null ? null : Number(retryAfter)
      );
    }
    if (parsed === null) {
      throw new VirtualJudgeError(res.status, "unexpected_response", "Response body was not JSON.", null);
    }
    return parsed as T;
  }
}
