import { JobHandlerError } from "../jobs/worker.js";
import type { RelayContentCustody } from "./index.js";

export const SOURCE_CONTENT_WITHDRAWAL_JOB = "source-content-withdrawal";
export const SOURCE_CONTENT_PURGE_JOB = "source-content-purge";

export function createSourceContentJobHandlers(custody: RelayContentCustody) {
  return {
    [SOURCE_CONTENT_WITHDRAWAL_JOB]: async (job: { organizationId: string | null; payload: unknown }) => {
      const payload = job.payload as Partial<{ sourceVersionRef: string; commandId: string }>;
      if (!job.organizationId || !payload || typeof payload.sourceVersionRef !== "string"
        || typeof payload.commandId !== "string") {
        throw new JobHandlerError("source_withdrawal_job_invalid", false);
      }
      return custody.withdraw({ organizationId: job.organizationId,
        sourceVersionRef: payload.sourceVersionRef, commandId: payload.commandId,
        authenticated: true });
    },
    [SOURCE_CONTENT_PURGE_JOB]: async () => custody.purge(),
  };
}
