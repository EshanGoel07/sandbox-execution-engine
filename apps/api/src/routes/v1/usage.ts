/**
 * Records every authenticated /api/v1 request in api_usage — attributed to
 * the KEY that made it — without ever making the request wait on that write.
 *
 * The middleware only pushes a small record into an in-memory buffer when the
 * response finishes; a timer flushes the buffer to Postgres as ONE batched
 * INSERT per interval. So the request path costs an array push, and the
 * database sees one statement a second instead of one per request.
 *
 * Trade-offs, deliberately accepted because usage is analytics, not billing:
 *   - a crash loses at most one flush interval of rows;
 *   - if Postgres is down the buffer is capped, and the oldest rows are
 *     dropped (and counted in the log) rather than growing without bound.
 * Enforcement never depends on this table — the limits live in Redis.
 */
import type { NextFunction, Response } from "express";
import { insertUsageBatch } from "@vj/infra";
import type { UsageRecord } from "@vj/infra";
import type { ApiKeyRequest } from "../../auth/api-key";

const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFERED = 10_000;

let buffer: UsageRecord[] = [];
let dropped = 0;
let flushing = false;

// Route PATTERNS, so an execution id never becomes part of the endpoint label.
function endpointLabel(method: string, path: string): string {
  if (path === "/api/v1/languages") return `${method} /api/v1/languages`;
  if (path === "/api/v1/executions") return `${method} /api/v1/executions`;
  if (/^\/api\/v1\/executions\/[^/]+$/.test(path)) return `${method} /api/v1/executions/:id`;
  return `${method} (unmatched)`;
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    await insertUsageBatch(batch);
  } catch (err) {
    // Put the batch back (ahead of anything newer) and try again next tick,
    // keeping the most recent MAX_BUFFERED rows.
    buffer = batch.concat(buffer);
    if (buffer.length > MAX_BUFFERED) {
      dropped += buffer.length - MAX_BUFFERED;
      buffer = buffer.slice(buffer.length - MAX_BUFFERED);
    }
    console.error(`[api/v1] usage flush failed (${buffer.length} buffered, ${dropped} dropped):`, err);
  } finally {
    flushing = false;
  }
}

setInterval(() => void flush(), FLUSH_INTERVAL_MS).unref();

/** Flushes whatever is buffered now. For graceful shutdown and tests. */
export function flushUsage(): Promise<void> {
  return flush();
}

/** Mount after requireApiKey (needs the key) and before the rate limiter (so 429s are recorded too). */
export function recordUsage(req: ApiKeyRequest, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const { id: apiKeyId, userId } = req.apiKey!;
  const path = req.originalUrl.split("?")[0];

  res.on("finish", () => {
    buffer.push({
      apiKeyId,
      userId,
      endpoint: endpointLabel(req.method, path),
      statusCode: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
      createdAt: new Date(),
    });
    if (buffer.length > MAX_BUFFERED) {
      buffer.shift();
      dropped++;
    }
  });
  next();
}
