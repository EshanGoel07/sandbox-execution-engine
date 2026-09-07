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
  STREAM_KEY,
  GROUP_NAME,
  enqueueSubmission,
  createConsumerConnection,
  ensureConsumerGroup,
  readNextSubmission,
  readOwnPending,
  acknowledgeSubmission,
  pendingCount,
  closeStream,
} from "./stream";
export type { StreamMessage } from "./stream";
