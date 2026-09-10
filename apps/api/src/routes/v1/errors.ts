/**
 * The public API's uniform error envelope:
 *
 *   { "error": { "code": "invalid_language", "message": "Unknown language 'rust'." } }
 *
 * `code` is the contract — stable, machine-readable, safe to switch on.
 * `message` is for humans and may change wording at any time.
 */
import type { NextFunction, Request, Response } from "express";

export type ErrorCode =
  | "unauthorized"
  | "key_revoked"
  | "rate_limited"
  | "quota_exceeded"
  | "concurrency_limited"
  | "invalid_request"
  | "invalid_language"
  | "source_too_large"
  | "not_found"
  | "execution_disabled"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Last route in the v1 tree: anything unmatched is a not_found, in the envelope. */
export function notFound(req: Request, res: Response): void {
  sendError(res, 404, "not_found", `No route ${req.method} ${req.baseUrl}${req.path}.`);
}

/**
 * Error middleware for the v1 tree. Express 5 forwards rejected promises from
 * async handlers here, so handlers just `throw new ApiError(...)`.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  const type = (err as { type?: string } | null)?.type;
  if (type === "entity.too.large") {
    sendError(res, 413, "invalid_request", "Request body too large.");
    return;
  }
  if (type === "entity.parse.failed") {
    sendError(res, 400, "invalid_request", "Request body is not valid JSON.");
    return;
  }
  // Log the error itself, never the request — its Authorization header is a
  // live API key.
  console.error("[api/v1] unhandled error:", err);
  sendError(res, 500, "internal", "Internal server error.");
}
