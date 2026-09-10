/**
 * POST /api/v1/executions   — queue one run, answer 202 immediately
 * GET  /api/v1/executions/:id — poll its status / result
 *
 * Async by design. The request does an INSERT and an XADD and returns; the
 * run itself happens on a worker. That is what keeps API latency decoupled
 * from how long the submitted program takes — the same property the grading
 * path has. There is no server-side "wait": a client that wants one call
 * polls (the SDK's waitFor does exactly that).
 */
import { Router } from "express";
import { isLanguage } from "@vj/shared";
import { createExecution, enqueueExecution, failExecution, getExecutionForUser } from "@vj/infra";
import type { ExecutionRecord } from "@vj/infra";
import {
  DEMO_MODE,
  EXECUTION_MEMORY_MB,
  EXECUTION_TIME_MS,
  MAX_SOURCE_CODE_BYTES,
  MAX_STDIN_BYTES,
} from "../../config";
import { randomBase62 } from "../../auth/api-key";
import type { ApiKeyRequest } from "../../auth/api-key";
import { ApiError } from "./errors";
import { createExecutionSchema, parseBody } from "./schemas";

const EXECUTION_ID_RE = /^exec_[0-9A-Za-z]{22}$/;

// ~131 random bits: unguessable, and says nothing about how many exist.
function newExecutionId(): string {
  return `exec_${randomBase62(22)}`;
}

/** The wire shape of an execution. snake_case throughout, like every /api/v1 body. */
function toWire(e: ExecutionRecord) {
  return {
    id: e.id,
    status: e.status,
    language: e.language,
    limits: { time_ms: e.timeLimitMs, memory_mb: e.memoryLimitMb },
    created_at: e.createdAt,
    started_at: e.startedAt,
    completed_at: e.completedAt,
    result: e.result && {
      outcome: e.result.outcome,
      exit_code: e.result.exitCode,
      stdout: e.result.stdout,
      stderr: e.result.stderr,
      compile_output: e.result.compileOutput,
      output_truncated: e.result.outputTruncated,
      wall_time_ms: e.result.wallTimeMs,
    },
  };
}

export function executionsRouter(): Router {
  const router = Router();

  router.post("/executions", async (req: ApiKeyRequest, res) => {
    if (DEMO_MODE) {
      throw new ApiError(
        503,
        "execution_disabled",
        "Code execution is disabled on this deployment. Run the stack locally with `docker compose up`."
      );
    }

    const body = parseBody(createExecutionSchema, req.body);

    if (!isLanguage(body.language)) {
      throw new ApiError(
        400,
        "invalid_language",
        `Unknown language '${body.language}'. See GET /api/v1/languages.`
      );
    }
    if (Buffer.byteLength(body.source_code, "utf8") > MAX_SOURCE_CODE_BYTES) {
      throw new ApiError(
        413,
        "source_too_large",
        `source_code exceeds the ${MAX_SOURCE_CODE_BYTES}-byte limit.`
      );
    }
    const stdin = body.stdin ?? "";
    if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES) {
      throw new ApiError(400, "invalid_request", `stdin exceeds the ${MAX_STDIN_BYTES}-byte limit.`);
    }

    const { id: apiKeyId, userId } = req.apiKey!;
    const id = newExecutionId();
    const timeLimitMs = body.limits?.time_ms ?? EXECUTION_TIME_MS.max;
    const memoryLimitMb = body.limits?.memory_mb ?? EXECUTION_MEMORY_MB.max;

    const { createdAt } = await createExecution({
      id,
      userId,
      apiKeyId,
      language: body.language,
      sourceCode: body.source_code,
      stdin,
      timeLimitMs,
      memoryLimitMb,
    });

    try {
      await enqueueExecution(id);
    } catch (err) {
      // The row exists but no worker will ever see it. Mark it terminal so a
      // client polling this id gets `failed` instead of `queued` forever.
      await failExecution(id, "Could not enqueue the execution.").catch(() => {});
      throw err;
    }

    res
      .status(202)
      .location(`/api/v1/executions/${id}`)
      .json({ id, status: "queued", created_at: createdAt });
  });

  router.get("/executions/:id", async (req: ApiKeyRequest, res) => {
    const id = String(req.params.id);
    // A malformed id can't exist — skip the query. Same 404 as a missing or
    // someone else's id, so the response never confirms an id is real.
    const execution = EXECUTION_ID_RE.test(id)
      ? await getExecutionForUser(id, req.apiKey!.userId)
      : null;
    if (!execution) {
      throw new ApiError(404, "not_found", `No execution '${id}'.`);
    }
    res.json(toWire(execution));
  });

  return router;
}
