/**
 * The grading orchestration that sits on top of the stream transport:
 * read one submissionId, load it from Postgres, publish "Judging", grade it,
 * persist results, publish "Done", ACK.
 *
 * If a worker dies between reading and ACK, the message stays pending and is
 * not lost. A submission row that has vanished is ACKed anyway (retrying it
 * forever would just loop).
 */
import type Redis from "ioredis";
import {
  acknowledgeSubmission,
  ensureConsumerGroup,
  getSubmissionForGrading,
  publishSubmissionUpdate,
  readNextSubmission,
  saveGradeResult,
  updateSubmissionStatus,
} from "@vj/infra";
import type { GradeResult, Language } from "@vj/shared";
import { gradeSubmission } from "./grader";

export { createConsumerConnection } from "@vj/infra";

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

  const message = await readNextSubmission(consumerName, waitMs, client);
  if (!message) return null; // nothing arrived within waitMs
  const { id, submissionId } = message;

  const submission = await getSubmissionForGrading(submissionId);
  if (!submission) {
    await acknowledgeSubmission(id, client);
    throw new Error(`No submission found for id ${submissionId}`);
  }

  await updateSubmissionStatus(submissionId, "Judging");
  await publishSubmissionUpdate({ submissionId, status: "Judging" });

  const gradeResult = await gradeSubmission(
    submission.language as Language,
    submission.sourceCode,
    submission.testCases,
    submission.timeLimitMs
  );

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
