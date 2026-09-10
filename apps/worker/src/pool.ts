/**
 * Runs several consumers concurrently against one consumer group, each on
 * its own Redis connection (ioredis serializes commands per connection, so a
 * shared connection would let one consumer's blocking read stall the rest).
 *
 * The pool doesn't know what kind of work it does — `processOne` decides.
 * The worker process runs one pool per queue (grading, executions), each
 * with its own consumer count, so the two workloads never share capacity.
 */
import type Redis from "ioredis";
import { createConsumerConnection } from "@vj/infra";
import { processOneSubmission, SubmissionOutcome } from "./consume";

export type { SubmissionOutcome };

/** One iteration of a consumer: take at most one job, return its outcome (or null if none arrived). */
export type ProcessOne<T> = (consumerName: string, waitMs: number, client: Redis) => Promise<T | null>;

export interface WorkerPoolOptions<T = SubmissionOutcome> {
  count: number;
  waitMs?: number;
  onResult?: (outcome: T, consumerName: string) => void;
  /** Defaults to grading one submission. */
  processOne?: ProcessOne<T>;
  /** Consumer-name prefix, e.g. "worker" -> worker-0, worker-1. */
  name?: string;
}

interface Consumer {
  name: string;
  client: Redis;
}

// Exponential backoff bounds for a consumer loop that keeps erroring — a
// Docker daemon outage would otherwise have every consumer hot-loop on
// XREADGROUP + failed job as fast as the CPU allows.
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class WorkerPool<T = SubmissionOutcome> {
  private consumers: Consumer[] = [];
  private loops: Promise<void>[] = [];
  private shuttingDown = false;
  private readonly waitMs: number;
  private readonly processOne: ProcessOne<T>;

  constructor(private options: WorkerPoolOptions<T>) {
    this.waitMs = options.waitMs ?? 2000;
    // Without an explicit processOne, T is the default SubmissionOutcome.
    this.processOne = options.processOne ?? (processOneSubmission as unknown as ProcessOne<T>);
  }

  start(): void {
    const prefix = this.options.name ?? "worker";
    for (let i = 0; i < this.options.count; i++) {
      const consumer: Consumer = {
        name: `${prefix}-${i}`,
        client: createConsumerConnection(),
      };
      this.consumers.push(consumer);
      this.loops.push(this.runLoop(consumer));
    }
  }

  private async runLoop(consumer: Consumer): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.shuttingDown) {
      try {
        const outcome = await this.processOne(consumer.name, this.waitMs, consumer.client);
        consecutiveFailures = 0;
        if (outcome) {
          this.options.onResult?.(outcome, consumer.name);
        }
      } catch (err) {
        consecutiveFailures++;
        const backoff = Math.min(
          MAX_BACKOFF_MS,
          BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1)
        );
        console.error(
          `[${consumer.name}] error (#${consecutiveFailures}), backing off ${backoff}ms:`,
          err
        );
        await sleep(backoff);
      }
    }
  }

  // Signals every loop to stop pulling new work, then waits for each loop's
  // current BLOCK/job cycle to finish (bounded by waitMs) before closing
  // that consumer's connection. No in-flight job is interrupted.
  async stop(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.loops);
    await Promise.all(this.consumers.map((c) => c.client.quit()));
  }
}
