/**
 * The grading orchestration that sits on top of the stream transport:
 * read one submissionId, load it from Postgres, publish "Judging", grade it,
 * persist results, publish "Done", ACK.
 *
 * Failure handling splits two ways:
 *
 *   - Non-retryable (the message will never grade as-is): an unsupported
 *     language, or a deterministic error out of the engine. The submission is
 *     marked "Internal Error" and the message is ACKed — otherwise it sits
 *     unacked forever (a poison message) and the submission hangs in
 *     "Judging".
 *
 *   - Retryable (transient infrastructure): the Docker daemon is unreachable,
 *     Redis/Postgres blipped. The message is left unacked on purpose and a
 *     RetryableError is thrown; the pool backs off and this same consumer
 *     picks the message back up from its PEL on the next pass (readOwnPending).
 *
 * If a worker process dies between reading and ACK the message also stays
 * pending and is re-read on restart.
 */
import type Redis from "ioredis";
import {
  acknowledgeSubmission,
  ensureConsumerGroup,
  failSubmissionInternal,
  getSubmissionForGrading,
  publishSubmissionUpdate,
  readNextSubmission,
  readOwnPending,
  saveGradeResult,
  updateSubmissionStatus,
} from "@vj/infra";
import { isLanguage } from "@vj/shared";
import type { GradeResult, Language } from "@vj/shared";
import { gradeSubmission } from "./grader";
import { RetryableError, isRetryable } from "./retry";

export { createConsumerConnection } from "@vj/infra";
export { RetryableError };

function internalErrorResult(totalCount: number): GradeResult {
  return {
    verdict: "Internal Error",
    passedCount: 0,
    totalCount,
    failedOrdinal: null,
    results: [],
  };
}

export interface SubmissionOutcome {
  id: string;
  submissionId: number;
  gradeResult: GradeResult;
}

export async function processOneSubmission(
  consumerName: string,
  waitMs: number,
  client: Redis
): Promise<SubmissionOutcome | null> {
  await ensureConsumerGroup();

  // Retry this consumer's own backlog before blocking for new work.
  const message =
    (await readOwnPending(consumerName, client)) ??
    (await readNextSubmission(consumerName, waitMs, client));
  if (!message) return null; // nothing arrived within waitMs
  const { id, submissionId } = message;

  const submission = await getSubmissionForGrading(submissionId);
  if (!submission) {
    // The row was deleted out from under us — ACK and move on, retrying it
    // forever would just loop.
    await acknowledgeSubmission(id, client);
    return null;
  }

  // Poison-message guard: a language the engine can't run. `POST /submissions`
  // now rejects these at the boundary, so this only fires for rows written by
  // older code or directly against the DB.
  if (!isLanguage(submission.language)) {
    await failSubmissionInternal(
      submissionId,
      `Unsupported language "${submission.language}" — this submission can't be graded.`
    );
    await publishSubmissionUpdate({ submissionId, status: "Done", verdict: "Internal Error" });
    await acknowledgeSubmission(id, client);
    return { id, submissionId, gradeResult: internalErrorResult(submission.testCases.length) };
  }

  await updateSubmissionStatus(submissionId, "Judging");
  await publishSubmissionUpdate({ submissionId, status: "Judging" });

  let gradeResult: GradeResult;
  try {
    gradeResult = await gradeSubmission(
      submission.language as Language,
      submission.sourceCode,
      submission.testCases,
      submission.timeLimitMs
    );
  } catch (err) {
    if (isRetryable(err)) {
      // Leave the message unacked; the pool backs off and retries.
      throw new RetryableError(err);
    }
    // Deterministic engine failure — record it and ACK rather than loop.
    console.error(`[${consumerName}] submission ${submissionId} internal error:`, err);
    await failSubmissionInternal(
      submissionId,
      "The judge hit an internal error grading this submission."
    );
    await publishSubmissionUpdate({ submissionId, status: "Done", verdict: "Internal Error" });
    await acknowledgeSubmission(id, client);
    return { id, submissionId, gradeResult: internalErrorResult(submission.testCases.length) };
  }

  await saveGradeResult(submissionId, gradeResult);
  await publishSubmissionUpdate({
    submissionId,
    status: "Done",
    verdict: gradeResult.verdict,
    passedCount: gradeResult.passedCount,
    totalCount: gradeResult.totalCount,
    failedOrdinal: gradeResult.failedOrdinal,
  });

  await acknowledgeSubmission(id, client);

  return { id, submissionId, gradeResult };
}
