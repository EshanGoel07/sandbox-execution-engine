/**
 * The public API tree, mounted at /api/v1. API-key auth only.
 *
 * It exposes EXECUTION and nothing else — no problems, test cases, users or
 * grading. Everything a key can reach is in this router; the /app tree is a
 * separate router behind a separate auth strategy, so there is no route a key
 * can open by accident.
 *
 * Order matters:
 *   1. auth — nothing else runs for a caller without a live key, and an
 *      unauthenticated caller never gets a 256 KB body parsed on their behalf
 *   2. usage recording — before the limiter, so throttled requests are
 *      recorded too ("which key is getting 429s?" is a question worth answering)
 *   3. rate limit — before the body parser, so a throttled request costs no parsing
 *   4. body parser, routes, and this tree's own error handler, so every
 *      failure — bad JSON included — comes back in the uniform error envelope
 */
import express, { Router } from "express";
import { JSON_BODY_LIMIT } from "../../config";
import { requireApiKey } from "../../auth/api-key";
import { errorHandler, notFound } from "./errors";
import { executionsRouter } from "./executions";
import { languagesRouter } from "./languages";
import { rateLimit } from "./rate-limit";
import { recordUsage } from "./usage";

export function v1Router(): Router {
  const router = Router();

  router.use(requireApiKey);
  router.use(recordUsage);
  router.use(rateLimit);
  router.use(express.json({ limit: JSON_BODY_LIMIT }));

  router.use(languagesRouter());
  router.use(executionsRouter());

  router.use(notFound);
  router.use(errorHandler);
  return router;
}
