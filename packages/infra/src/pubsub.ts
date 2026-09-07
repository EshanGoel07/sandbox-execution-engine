/**
 * Bridges the worker (which judges submissions) and the API gateway (which
 * holds the WebSocket connections) via Redis Pub/Sub, so a client can watch a
 * submission's status change in real time instead of polling.
 *
 * Once a connection issues SUBSCRIBE, Redis puts it into subscriber mode
 * where it can no longer run ordinary commands — the same "one job per
 * connection" constraint as the consumer-group concurrency issue in
 * stream.ts, so publishing and subscribing each need their own connection.
 */
import Redis from "ioredis";
import type { SubmissionUpdate } from "@vj/shared";
import { createRedis } from "./redis-conn";

const CHANNEL = "submission-updates";

const publisher = createRedis();

export async function publishSubmissionUpdate(update: SubmissionUpdate): Promise<void> {
  await publisher.publish(CHANNEL, JSON.stringify(update));
}

export function subscribeToSubmissionUpdates(
  onUpdate: (update: SubmissionUpdate) => void
): Redis {
  const subscriber = createRedis();
  subscriber.subscribe(CHANNEL);
  subscriber.on("message", (_channel, message) => {
    onUpdate(JSON.parse(message) as SubmissionUpdate);
  });
  return subscriber;
}
