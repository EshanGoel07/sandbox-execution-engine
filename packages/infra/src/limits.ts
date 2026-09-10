/**
 * The public API's three usage controls, all in Redis and all keyed on the
 * ACCOUNT (user id), never the API key — keys are free to mint, so a per-key
 * limit could be multiplied just by minting more keys.
 *
 *   control            question it answers                       structure
 *   ─────────────────  ────────────────────────────────────────  ─────────────────────────────
 *   rate limit         too many requests in the last window?     sorted set of request times
 *   daily quota        used up today's executions?               counter per UTC day
 *   concurrency cap    too many executions in flight right now?  sorted set of execution ids
 *
 * The concurrency cap is the one that actually protects the system: a client
 * can be perfectly polite about request RATE and still queue hundreds of
 * slow executions, starving every other account of workers. Capping what is
 * in flight per account bounds how much of the queue any one account can hold.
 *
 * Every check-and-update runs as a Lua script, so it is atomic. A separate
 * "read the count" then "add one" would let two concurrent requests both
 * see count = limit - 1 and both get in.
 *
 * Time comes from Redis (`TIME`), not the API process, so several API
 * processes with slightly different clocks still agree on one window.
 */
import type Redis from "ioredis";
import { createRedis } from "./redis-conn";

const redis = createRedis();

export const rateLimitKey = (userId: number) => `vj:ratelimit:${userId}`;
export const inflightKey = (userId: number) => `vj:inflight:${userId}`;
export const quotaKey = (userId: number, utcDay: string) => `vj:quota:${userId}:${utcDay}`;

// Sliding-window log. Each accepted request is a member scored by its time;
// members older than the window are trimmed before counting. Exact (no 2x
// burst at a fixed-window boundary), at the cost of one entry per request in
// the window — trivial at per-minute limits. Rejected requests are not
// recorded, so a client retrying while limited doesn't extend its own
// lockout.
const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  count = count + 1
  allowed = 1
end
local reset_at = now + window
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then reset_at = tonumber(oldest[2]) + window end
return {allowed, count, reset_at, now}
`;

// Quota + concurrency, checked and consumed together: an execution either
// takes a slot AND a unit of quota, or neither. Checking quota first means a
// client who is out for the day hears that (it won't clear by waiting a few
// seconds) rather than a transient concurrency message.
//
// In-flight is a sorted set of execution ids scored by an expiry time, not an
// INCR/DECR counter. A counter leaks: if a worker crashes between "started"
// and "finished", the DECR never happens and that slot is gone for good —
// after enough crashes an account is locked out permanently. Here the worker
// ZREMs its id when done, and any id whose expiry has passed (its job must
// be long dead) is trimmed before counting, so a leak heals itself.
const ACQUIRE_EXECUTION_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= tonumber(ARGV[3]) then
  return {'quota_exceeded', used, redis.call('ZCARD', KEYS[1])}
end
local inflight = redis.call('ZCARD', KEYS[1])
if inflight >= tonumber(ARGV[2]) then
  return {'concurrency_limited', used, inflight}
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[4]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
used = redis.call('INCR', KEYS[2])
if used == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5])) end
return {'ok', used, inflight + 1}
`;

type LimitCommands = Redis & {
  vjSlidingWindow(key: string, windowMs: number, limit: number, member: string): Promise<number[]>;
  vjAcquireExecution(
    inflightKey: string,
    quotaKey: string,
    executionId: string,
    maxConcurrent: number,
    dailyQuota: number,
    inflightTtlMs: number,
    quotaTtlSeconds: number
  ): Promise<[string, number, number]>;
};

// defineCommand sends the script once and calls it by SHA afterwards
// (EVALSHA), re-sending it automatically if Redis has forgotten it.
redis.defineCommand("vjSlidingWindow", { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
redis.defineCommand("vjAcquireExecution", { numberOfKeys: 2, lua: ACQUIRE_EXECUTION_LUA });
const commands = redis as LimitCommands;

/** Current UTC day as YYYY-MM-DD — the quota's reset boundary. */
export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// Outlives the day it counts, whatever the clock skew; it is never read after.
const QUOTA_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the oldest request in the window ages out (Remaining next goes up). */
  resetAtMs: number;
  /** Redis's clock, for turning resetAtMs into a Retry-After. */
  nowMs: number;
}

export async function checkRateLimit(
  userId: number,
  limit: number,
  windowMs: number,
  requestId: string
): Promise<RateLimitDecision> {
  const [allowed, count, resetAtMs, nowMs] = await commands.vjSlidingWindow(
    rateLimitKey(userId),
    windowMs,
    limit,
    requestId
  );
  return {
    allowed: allowed === 1,
    limit,
    remaining: Math.max(0, limit - count),
    resetAtMs,
    nowMs,
  };
}

export type AcquireResult =
  | { ok: true; usedToday: number; inflight: number }
  | { ok: false; reason: "quota_exceeded" | "concurrency_limited"; usedToday: number; inflight: number };

export async function acquireExecutionSlot(input: {
  userId: number;
  executionId: string;
  day: string;
  maxConcurrent: number;
  dailyQuota: number;
  inflightTtlMs: number;
}): Promise<AcquireResult> {
  const [status, usedToday, inflight] = await commands.vjAcquireExecution(
    inflightKey(input.userId),
    quotaKey(input.userId, input.day),
    input.executionId,
    input.maxConcurrent,
    input.dailyQuota,
    input.inflightTtlMs,
    QUOTA_KEY_TTL_SECONDS
  );
  if (status === "ok") return { ok: true, usedToday, inflight };
  return { ok: false, reason: status as "quota_exceeded" | "concurrency_limited", usedToday, inflight };
}

/** Frees an execution's in-flight slot. Called by the worker once the execution is terminal. */
export async function releaseExecutionSlot(userId: number, executionId: string): Promise<void> {
  await redis.zrem(inflightKey(userId), executionId);
}

/**
 * Undoes acquireExecutionSlot when the execution never made it onto the queue
 * (the INSERT or XADD failed): free the slot and give the quota unit back.
 */
export async function refundExecutionSlot(
  userId: number,
  executionId: string,
  day: string
): Promise<void> {
  await redis.multi().zrem(inflightKey(userId), executionId).decr(quotaKey(userId, day)).exec();
}
