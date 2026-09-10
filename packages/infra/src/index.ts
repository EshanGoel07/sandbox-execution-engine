export { pool } from "./db";
export {
  listProblems,
  createProblem,
  getProblemPublic,
  createSubmission,
  markSubmissionDemoDisabled,
  createUser,
  getUserByEmail,
  getUserById,
  getUserProfile,
  getUserSubmissionsForProblem,
  getSubmissionForGrading,
  updateSubmissionStatus,
  getSubmissionStatus,
  saveGradeResult,
  getSubmissionForOwner,
  getSubmissionOwnerId,
  failSubmissionInternal,
} from "./db";
export type { NewProblem, NewTestCase, UserRow, SubmissionForGrading } from "./db";

export { runMigrations, MIGRATIONS_DIR } from "./migrate";
export { seed } from "./seed";

export { createRedis } from "./redis-conn";
export { publishSubmissionUpdate, subscribeToSubmissionUpdates } from "./pubsub";

export {
  submissionQueue,
  executionQueue,
  STREAM_KEY,
  GROUP_NAME,
  enqueueSubmission,
  enqueueExecution,
  createConsumerConnection,
  ensureConsumerGroup,
  readNextSubmission,
  readOwnPending,
  acknowledgeSubmission,
  pendingCount,
  closeStream,
} from "./stream";
export type { StreamMessage, StreamQueue, QueueMessage } from "./stream";

export {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  findApiKeyByHash,
  touchApiKeyLastUsed,
} from "./api-keys";
export type { ApiKeySummary, ApiKeyIdentity } from "./api-keys";

export {
  createExecution,
  getExecutionForUser,
  getExecutionJob,
  markExecutionRunning,
  saveExecutionResult,
  failExecution,
} from "./executions";
export type {
  NewExecution,
  ExecutionJob,
  ExecutionResultRecord,
  ExecutionRecord,
} from "./executions";

export {
  checkRateLimit,
  acquireExecutionSlot,
  releaseExecutionSlot,
  refundExecutionSlot,
  utcDay,
  rateLimitKey,
  inflightKey,
  quotaKey,
} from "./limits";
export type { RateLimitDecision, AcquireResult } from "./limits";

export { insertUsageBatch, getApiKeyUsage } from "./usage";
export type { UsageRecord, ApiKeyUsageDay } from "./usage";
