/**
 * Redis Streams work queues. A stream is an append-only log; a consumer
 * group tracks, per message, which consumer is working it and whether it's
 * been acked. If a worker dies mid-job the message just sits unacked instead
 * of vanishing.
 *
 * A message only ever carries an id — Postgres is the source of truth for
 * the actual language/source/limits, so a worker always works from current DB
 * state, and the queue stays cheap regardless of payload size.
 *
 * There are two queues, one per kind of work, each with its own stream,
 * consumer group and (in the worker) its own dedicated consumers:
 *
 *   submissions / judges     — grading for the judge app
 *   executions  / executors  — one-off runs from the public API
 *
 * Separate streams are a bulkhead: a flood of public API executions can back
 * up its own queue, but it can't delay a single grading job, and vice versa.
 * A shared stream would make the two workloads compete for the same consumers.
 *
 * This module is the *transport*: enqueue, group setup, read, ack. The
 * orchestration on top lives in the worker.
 */
import Redis from "ioredis";
import { createRedis } from "./redis-conn";

const redis = createRedis();

export interface QueueMessage {
  /** Redis stream entry id, needed to ACK. */
  id: string;
  /** The job's id (a submission id or an execution id), as written by enqueue. */
  jobId: string;
}

export interface StreamQueue {
  readonly stream: string;
  readonly group: string;
  enqueue(jobId: string | number): Promise<string>;
  ensureGroup(): Promise<void>;
  /** Blocks up to waitMs for the next unassigned message; null if none arrived. */
  readNext(consumerName: string, waitMs: number, client: Redis): Promise<QueueMessage | null>;
  /**
   * This consumer's own already-delivered-but-unacked messages (id "0" reads
   * the PEL, not new entries). A transient failure — Docker daemon down, a DB
   * blip — leaves the message unacked on purpose; on the next pass the same
   * worker picks it back up here and retries it, instead of the job being
   * stranded. Non-blocking: null immediately when there is no backlog.
   */
  readOwnPending(consumerName: string, client: Redis): Promise<QueueMessage | null>;
  ack(id: string, client: Redis): Promise<void>;
  pendingCount(): Promise<number>;
}

function parseFirstMessage(response: unknown, field: string): QueueMessage | null {
  if (!response) return null;
  const [, messages] = (response as [string, [string, string[]][]][])[0];
  if (!messages || messages.length === 0) return null;
  const [id, fields] = messages[0];

  const fieldMap: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) fieldMap[fields[i]] = fields[i + 1];

  return { id, jobId: fieldMap[field] };
}

function createStreamQueue(stream: string, group: string, field: string): StreamQueue {
  return {
    stream,
    group,

    async enqueue(jobId) {
      const id = await redis.xadd(stream, "*", field, String(jobId));
      if (!id) throw new Error("XADD did not return a message id");
      return id;
    },

    async ensureGroup() {
      try {
        // "0" starts the group's cursor at the beginning of the stream, so
        // messages enqueued before the group existed still get delivered.
        // MKSTREAM creates the stream if it doesn't exist yet.
        await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
      } catch (err: unknown) {
        if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
      }
    },

    async readNext(consumerName, waitMs, client) {
      const response = await client.xreadgroup(
        "GROUP", group, consumerName,
        "COUNT", 1,
        "BLOCK", waitMs,
        "STREAMS", stream, ">"
      );
      return parseFirstMessage(response, field);
    },

    async readOwnPending(consumerName, client) {
      const response = await client.xreadgroup(
        "GROUP", group, consumerName,
        "COUNT", 1,
        "STREAMS", stream, "0"
      );
      return parseFirstMessage(response, field);
    },

    async ack(id, client) {
      await client.xack(stream, group, id);
    },

    async pendingCount() {
      const summary = (await redis.xpending(stream, group)) as unknown[] | null;
      return summary ? Number(summary[0]) : 0;
    },
  };
}

export const submissionQueue = createStreamQueue("submissions", "judges", "submissionId");
export const executionQueue = createStreamQueue("executions", "executors", "executionId");

// Each concurrent consumer must get its own connection: ioredis serializes
// commands on a connection, so a blocking XREADGROUP on a shared connection
// would stall every other consumer using it.
export function createConsumerConnection(): Redis {
  return redis.duplicate();
}

export async function closeStream(): Promise<void> {
  await redis.quit();
}

// --- submission-queue shorthands (the grading pipeline's original API) -----

export const STREAM_KEY = submissionQueue.stream;
export const GROUP_NAME = submissionQueue.group;

export interface StreamMessage {
  /** Redis stream entry id, needed to ACK. */
  id: string;
  submissionId: number;
}

function toSubmissionMessage(message: QueueMessage | null): StreamMessage | null {
  return message ? { id: message.id, submissionId: Number(message.jobId) } : null;
}

export const enqueueSubmission = (submissionId: number) => submissionQueue.enqueue(submissionId);
export const ensureConsumerGroup = () => submissionQueue.ensureGroup();
export const readNextSubmission = async (consumerName: string, waitMs: number, client: Redis) =>
  toSubmissionMessage(await submissionQueue.readNext(consumerName, waitMs, client));
export const readOwnPending = async (consumerName: string, client: Redis) =>
  toSubmissionMessage(await submissionQueue.readOwnPending(consumerName, client));
export const acknowledgeSubmission = (id: string, client: Redis) => submissionQueue.ack(id, client);
export const pendingCount = () => submissionQueue.pendingCount();

export const enqueueExecution = (executionId: string) => executionQueue.enqueue(executionId);
