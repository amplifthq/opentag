import { JobHandlerError } from "../jobs/worker.js";
import {
  parseVerifiedSourceWithdrawalCommand,
  type RelayContentCustody,
} from "./index.js";

export const SOURCE_CONTENT_WITHDRAWAL_JOB = "source-content-withdrawal";
export const SOURCE_CONTENT_PURGE_JOB = "source-content-purge";

const PERMANENT_SOURCE_CONTENT_ERRORS = new Set([
  "source_content_unavailable",
  "source_invalidation_receipt_invalid",
  "source_invalidation_failed",
  "source_invalidation_unavailable",
  "source_withdrawal_conflict",
  "source_withdrawal_verification_invalid",
]);

function postgresErrorIsTransient(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : "";
  return code.startsWith("08")
    || ["40001", "40P01", "53300", "57P01", "57P02", "57P03"].includes(code);
}

function sourceContentJobError(error: unknown): JobHandlerError {
  const code = error instanceof Error ? error.message : "";
  if (PERMANENT_SOURCE_CONTENT_ERRORS.has(code)) return new JobHandlerError(code, false);
  if (code === "source_invalidation_transient") {
    return new JobHandlerError("source_invalidation_transient", true);
  }
  if (postgresErrorIsTransient(error)) {
    return new JobHandlerError("source_content_database_transient", true);
  }
  return new JobHandlerError("source_content_job_failed", false);
}

export function createSourceContentJobHandlers(custody: RelayContentCustody) {
  return {
    [SOURCE_CONTENT_WITHDRAWAL_JOB]: async (job: { organizationId: string | null; payload: unknown }) => {
      let command;
      try {
        command = parseVerifiedSourceWithdrawalCommand(job.payload);
      } catch {
        throw new JobHandlerError("source_withdrawal_verification_invalid", false);
      }
      if (!job.organizationId || command.organizationId !== job.organizationId) {
        throw new JobHandlerError("source_withdrawal_verification_invalid", false);
      }
      try {
        return await custody.withdraw(command);
      } catch (error) {
        throw sourceContentJobError(error);
      }
    },
    [SOURCE_CONTENT_PURGE_JOB]: async () => {
      try {
        return await custody.purge();
      } catch (error) {
        throw sourceContentJobError(error);
      }
    },
  };
}
