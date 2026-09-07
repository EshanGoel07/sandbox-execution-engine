/**
 * One place that knows how to build a Redis connection. Locally there are no
 * env vars and ioredis's defaults (127.0.0.1:6379) are exactly right; in
 * docker-compose / on a hosting provider, REDIS_URL is set (redis://redis:6379
 * or a managed rediss:// URL) and every connection in the process uses it.
 *
 * ioredis serializes commands per connection and a blocking read or a
 * SUBSCRIBE monopolises one, so the worker and the pub/sub layer each open
 * several of these rather than sharing one — hence a factory, not a singleton.
 */
import Redis, { RedisOptions } from "ioredis";

export function createRedis(extra: RedisOptions = {}): Redis {
  const url = process.env.REDIS_URL;
  return url ? new Redis(url, extra) : new Redis(extra);
}
