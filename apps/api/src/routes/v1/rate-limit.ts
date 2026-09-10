/**
 * Per-account sliding-window rate limit for every authenticated /api/v1
 * request, plus the X-RateLimit-* headers every response carries:
 *
 *   X-RateLimit-Limit      requests allowed per window
 *   X-RateLimit-Remaining  requests left in the current window
 *   X-RateLimit-Reset      Unix time (seconds) when the oldest counted request
 *                          leaves the window, i.e. when Remaining next goes up
 *
 * Over the limit: 429 `rate_limited` with Retry-After (seconds).
 *
 * The daily quota and the concurrency cap are NOT here — they only apply to
 * creating an execution, so they live in that handler (executions.ts).
 */
import { randomUUID } from "crypto";
import type { NextFunction, Response } from "express";
import { checkRateLimit } from "@vj/infra";
import { API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW_MS } from "../../config";
import type { ApiKeyRequest } from "../../auth/api-key";
import { sendError } from "./errors";

export async function rateLimit(req: ApiKeyRequest, res: Response, next: NextFunction): Promise<void> {
  let decision;
  try {
    decision = await checkRateLimit(
      req.apiKey!.userId,
      API_RATE_LIMIT_MAX,
      API_RATE_LIMIT_WINDOW_MS,
      randomUUID()
    );
  } catch (err) {
    // Fail open: a limiter outage shouldn't take reads down with it. Creating
    // an execution still needs Redis (the queue lives there), so nothing can
    // be enqueued unmetered while this is failing.
    console.error("[api/v1] rate limiter unavailable, allowing request:", err);
    next();
    return;
  }

  res.setHeader("X-RateLimit-Limit", String(decision.limit));
  res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(decision.resetAtMs / 1000)));

  if (!decision.allowed) {
    const retryAfter = Math.max(1, Math.ceil((decision.resetAtMs - decision.nowMs) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    sendError(
      res,
      429,
      "rate_limited",
      `Rate limit of ${decision.limit} requests per ${API_RATE_LIMIT_WINDOW_MS / 1000}s exceeded. Retry in ${retryAfter}s.`
    );
    return;
  }
  next();
}
