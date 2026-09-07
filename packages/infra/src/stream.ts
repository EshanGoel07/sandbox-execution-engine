/**
 * Redis Streams queue in front of the grader. A stream is an append-only
 * log; a consumer group tracks, per message, which consumer is working it
 * and whether it's been acked. If a worker dies mid-job the message just
 * sits unacked instead of vanishing.
 *
 * The stream only ever carries a submissionId — Postgres is the source of
 * truth for the actual language/source/test cases, so a worker always grades
 * against current DB state, and the queue stays cheap even for large
 * submissions.
 *
 * This module is the *transport*: enqueue, group setup, read, ack. The
 * grading orchestration that sits on top lives in the worker.
 */
import Redis from "ioredis";
import { createRedis } from "./redis-conn";

export const STREAM_KEY = "submissions";
export const GROUP_NAME = "judges";

const redis = createRedis();

export async function enqueueSubmission(submissionId: number): Promise<string> {
  const id = await redis.xadd(STREAM_KEY, "*", "submissionId", String(submissionId));
  if (!id) throw new Error("XADD did not return a message id");
  return id;
}

// Each concurrent consumer must get its own connection: ioredis serializes
// commands on a connection, so a blocking XREADGROUP on a shared connection
// would stall every other consumer using it.
export function createConsumerConnection(): Redis {
  return redis.duplicate();
}

export async function ensureConsumerGroup(): Promise<void> {
  try {
    // "0" starts the group's cursor at the beginning of the stream, so
    // messages enqueued before the group existed still get delivered.
    // MKSTREAM creates the stream if it doesn't exist yet.
    await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
  } catch (err: unknown) {
    if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
  }
}

export interface StreamMessage {
  /** Redis stream entry id, needed to ACK. */
  id: string;
  submissionId: number;
}

// Blocks up to waitMs for the next unassigned message; null if none arrived.
export async function readNextSubmission(
  consumerName: string,
  waitMs: number,
  client: Redis
): Promise<StreamMessage | null> {
  const response = await client.xreadgroup(
    "GROUP", GROUP_NAME, consumerName,
    "COUNT", 1,
    "BLOCK", waitMs,
    "STREAMS", STREAM_KEY, ">"
  );
  if (!response) return null;

  const [, messages] = response[0] as [string, [string, string[]][]];
  const [id, fields] = messages[0];

  const fieldMap: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) fieldMap[fields[i]] = fields[i + 1];

  return { id, submissionId: Number(fieldMap.submissionId) };
}

export async function acknowledgeSubmission(id: string, client: Redis): Promise<void> {
  await client.xack(STREAM_KEY, GROUP_NAME, id);
}

export async function pendingCount(): Promise<number> {
  const summary = (await redis.xpending(STREAM_KEY, GROUP_NAME)) as unknown[] | null;
  return summary ? Number(summary[0]) : 0;
}

export async function closeStream(): Promise<void> {
  await redis.quit();
}
