/**
 * Request-body schemas for the public API. Every object is strict: an
 * unknown field is a 400, not silently ignored. That matters for a public
 * contract — a client sending `callback_url` to an API that doesn't support
 * webhooks should hear "unrecognized field", not get a 202 and wait forever
 * for a callback that will never come.
 */
import { z } from "zod";
import { EXECUTION_MEMORY_MB, EXECUTION_TIME_MS } from "../../config";
import { ApiError } from "./errors";

const range = (r: { min: number; max: number }) => `must be an integer between ${r.min} and ${r.max}`;

export const createExecutionSchema = z.strictObject({
  // Only the type is checked here; an unknown language gets its own error
  // code (invalid_language) in the handler.
  language: z.string(),
  source_code: z.string(),
  stdin: z.string().optional(),
  limits: z
    .strictObject({
      time_ms: z
        .number()
        .int({ error: range(EXECUTION_TIME_MS) })
        .min(EXECUTION_TIME_MS.min, { error: range(EXECUTION_TIME_MS) })
        .max(EXECUTION_TIME_MS.max, { error: range(EXECUTION_TIME_MS) })
        .optional(),
      memory_mb: z
        .number()
        .int({ error: range(EXECUTION_MEMORY_MB) })
        .min(EXECUTION_MEMORY_MB.min, { error: range(EXECUTION_MEMORY_MB) })
        .max(EXECUTION_MEMORY_MB.max, { error: range(EXECUTION_MEMORY_MB) })
        .optional(),
    })
    .optional(),
});

export type CreateExecutionBody = z.infer<typeof createExecutionSchema>;

/** Validates `body` or throws an `invalid_request` ApiError naming the first bad field. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path.join(".");
  throw new ApiError(400, "invalid_request", path ? `${path}: ${issue.message}` : issue.message);
}
