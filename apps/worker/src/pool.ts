/**
 * Runs several consumers concurrently against the same consumer group, each
 * on its own Redis connection (ioredis serializes commands per connection, so
 * a shared connection would let one consumer's blocking read stall the rest).
 */
import type Redis from "ioredis";
import { createConsumerConnection } from "@vj/infra";
import { processOneSubmission, SubmissionOutcome } from "./consume";

export type { SubmissionOutcome };

export interface WorkerPoolOptions {
  count: number;
  waitMs?: number;
  onResult?: (outcome: SubmissionOutcome, consumerName: string) => void;
}

interface Consumer {
  name: string;
  client: Redis;
}

export class WorkerPool {
  private consumers: Consumer[] = [];
  private loops: Promise<void>[] = [];
  private shuttingDown = false;
  private readonly waitMs: number;

  constructor(private options: WorkerPoolOptions) {
    this.waitMs = options.waitMs ?? 2000;
  }

  start(): void {
    for (let i = 0; i < this.options.count; i++) {
      const consumer: Consumer = {
        name: `worker-${i}`,
        client: createConsumerConnection(),
      };
      this.consumers.push(consumer);
      this.loops.push(this.runLoop(consumer));
    }
  }

  private async runLoop(consumer: Consumer): Promise<void> {
    while (!this.shuttingDown) {
      try {
        const outcome = await processOneSubmission(consumer.name, this.waitMs, consumer.client);
        if (outcome) {
          this.options.onResult?.(outcome, consumer.name);
        }
      } catch (err) {
        console.error(`[${consumer.name}] error:`, err);
      }
    }
  }

  // Signals every loop to stop pulling new work, then waits for each loop's
  // current BLOCK/judge cycle to finish (bounded by waitMs) before closing
  // that consumer's connection. No in-flight job is interrupted.
  async stop(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.loops);
    await Promise.all(this.consumers.map((c) => c.client.quit()));
  }
}
