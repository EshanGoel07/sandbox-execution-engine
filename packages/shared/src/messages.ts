/**
 * Real-time messages that cross a process boundary: the worker publishes
 * them on Redis Pub/Sub, the API's WebSocket hub forwards them to browsers.
 */

/** Live push emitted by the worker as a submission moves through grading. */
export interface SubmissionUpdate {
  submissionId: number;
  status: "Judging" | "Done";
  verdict?: string;
  passedCount?: number;
  totalCount?: number;
  failedOrdinal?: number | null;
}

/**
 * DB-backed snapshot the WebSocket hub sends the instant a client subscribes,
 * so a client that connects *after* grading finished still learns the outcome
 * instead of waiting forever.
 */
export interface SubmissionStatusPayload {
  submissionId: number;
  status: string;
  verdict: string | null;
  passedCount: number | null;
  totalCount: number | null;
  failedOrdinal: number | null;
  message: string | null;
}
