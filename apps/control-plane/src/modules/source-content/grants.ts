import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withPostgresTransaction } from "../../database/postgres.js";
import { deriveSourceContentGrantToken, type RelayContentKey } from "./crypto.js";

export const hashGrantToken = (token: string) => createHash("sha256")
  .update(token, "utf8").digest("hex");

export type SourceContentReadGrant = { grantId: string; token: string; keyVersion: string;
  fenceDigest: string; contentIds: string[]; purpose: "source_context"; expiresAt: string };

type GrantRow = {
  grant_id: string; organization_id: string; token_hash: string; run_id: string;
  attempt_id: string; fence_digest: string; content_ids: string[]; purpose: string;
  key_version: string; expires_at: Date; consumed_at: Date | null; revoked_at: Date | null;
};

const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
export const normalizeContentIds = (ids: readonly string[]) =>
  [...new Set(ids)].sort();

export function createSourceContentGrantStore(input: {
  pool: Pool; clock: { now(): Date }; key: RelayContentKey;
}) {
  const issueInTransaction = async (client: PoolClient, command: {
    organizationId: string; runId: string; attemptId: string; fenceDigest: string;
    contentIds: string[]; purpose: "source_context"; expiresAt: Date;
  }): Promise<SourceContentReadGrant> => {
    const contentIds = normalizeContentIds(command.contentIds);
    if (!command.organizationId || !command.runId || !command.attemptId
      || !command.fenceDigest || !command.purpose || contentIds.length === 0
      || [command.organizationId, command.runId, command.attemptId,
        command.fenceDigest, command.purpose, ...contentIds]
        .some((value) => value.length > 512)
      || !Number.isFinite(command.expiresAt.getTime())
      || command.expiresAt.getTime() <= input.clock.now().getTime()) {
      throw new Error("source_content_grant_invalid");
    }
    const existing = await client.query<GrantRow>(
      `SELECT * FROM cp_source_content_read_grant
       WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3 FOR UPDATE`,
      [command.organizationId, command.runId, command.attemptId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.fence_digest !== command.fenceDigest || row.purpose !== command.purpose
        || row.key_version !== input.key.keyVersion
        || row.expires_at.getTime() !== command.expiresAt.getTime()
        || !same(row.content_ids, contentIds)) {
        throw new Error("source_content_grant_conflict");
      }
      const token = deriveSourceContentGrantToken({ key: input.key, ...command, contentIds });
      if (hashGrantToken(token) !== row.token_hash) throw new Error("source_content_grant_invalid");
      return { grantId: row.grant_id, token, keyVersion: row.key_version,
        fenceDigest: row.fence_digest, contentIds: row.content_ids,
        purpose: row.purpose, expiresAt: row.expires_at.toISOString() };
    }
    const token = deriveSourceContentGrantToken({ key: input.key, ...command, contentIds });
    const grantId = `source_grant_${randomBytes(16).toString("hex")}`;
    const locked = await client.query<{ content_id: string }>(
      `SELECT content_id FROM cp_source_content
       WHERE organization_id = $1 AND content_id = ANY($2::text[])
         AND purpose = $3 AND deleted_at IS NULL AND expires_at >= $4
       ORDER BY content_id FOR UPDATE`,
      [command.organizationId, contentIds, command.purpose, command.expiresAt],
    );
    if (!same(locked.rows.map((row) => row.content_id), contentIds)) {
      throw new Error("source_content_unavailable");
    }
    await client.query(
      `INSERT INTO cp_source_content_read_grant(
         grant_id, organization_id, token_hash, run_id, attempt_id,
         fence_digest, content_ids, purpose, key_version, expires_at, created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [grantId, command.organizationId, hashGrantToken(token), command.runId,
        command.attemptId, command.fenceDigest, contentIds, command.purpose,
        input.key.keyVersion, command.expiresAt, input.clock.now()],
    );
    return { grantId, token, keyVersion: input.key.keyVersion,
      fenceDigest: command.fenceDigest, contentIds, purpose: command.purpose,
      expiresAt: command.expiresAt.toISOString() };
  };
  return {
    issueInTransaction,
    async issue(command: {
      organizationId: string; runId: string; attemptId: string; fenceDigest: string;
      contentIds: string[]; purpose: "source_context"; expiresAt: Date;
    }): Promise<SourceContentReadGrant> {
      return withPostgresTransaction(input.pool, (client) =>
        issueInTransaction(client as PoolClient, command));
    },

    async consume<T>(command: {
      grantId: string; token: string; organizationId: string; runId: string;
      attemptId: string; fenceDigest: string; contentIds: string[]; purpose: string;
      authorizeInTransaction?: (client: PoolClient) => Promise<boolean>;
    }, operation: (client: PoolClient, contentIds: string[]) => Promise<T>): Promise<T> {
      return withPostgresTransaction(input.pool, async (client) => {
        if (command.authorizeInTransaction
          && !(await command.authorizeInTransaction(client as PoolClient))) {
          throw new Error("source_content_grant_stale");
        }
        const result = await client.query<GrantRow>(
          "SELECT * FROM cp_source_content_read_grant WHERE token_hash = $1 FOR UPDATE",
          [hashGrantToken(command.token)],
        );
        const row = result.rows[0];
        if (!row || row.grant_id !== command.grantId) throw new Error("source_content_grant_invalid");
        if (row.organization_id !== command.organizationId) throw new Error("source_content_context_mismatch");
        if (row.consumed_at) throw new Error("source_content_grant_consumed");
        if (row.revoked_at) throw new Error("source_content_deleted");
        if (row.expires_at.getTime() <= input.clock.now().getTime()) {
          throw new Error("source_content_grant_expired");
        }
        const requestedIds = normalizeContentIds(command.contentIds);
        if (row.run_id !== command.runId || row.attempt_id !== command.attemptId
          || row.fence_digest !== command.fenceDigest || row.purpose !== command.purpose
          || !same(row.content_ids, requestedIds)) {
          throw new Error("source_content_grant_invalid");
        }
        const hostedRun = await client.query<{ terminal_kind: string | null;
          current_attempt_number: number }>(
          `SELECT terminal_kind, current_attempt_number FROM cp_hosted_run
           WHERE organization_id = $1 AND run_id = $2 FOR UPDATE`,
          [command.organizationId, command.runId],
        );
        const runAuthority = hostedRun.rows[0];
        const hostedAttempt = runAuthority ? await client.query<{
          attempt_id: string; fencing_token_digest: string; lease_expires_at: Date;
          state: string; material_start_state: string;
        }>(
          `SELECT attempt_id, fencing_token_digest, lease_expires_at, state,
                  material_start_state FROM cp_hosted_attempt
           WHERE organization_id = $1 AND run_id = $2 AND attempt_number = $3
             AND attempt_id = $4 FOR UPDATE`,
          [command.organizationId, command.runId, runAuthority.current_attempt_number,
            command.attemptId],
        ) : { rows: [] };
        const authority = hostedAttempt.rows[0];
        if (runAuthority && (runAuthority.terminal_kind !== null
          || !authority
          || authority.fencing_token_digest !== command.fenceDigest
          || authority.lease_expires_at.getTime() <= input.clock.now().getTime()
          || !["claimed", "running", "needs_approval"].includes(authority.state)
          || !["open", "started_or_ambiguous"].includes(
            authority.material_start_state ?? "",
          ))) {
          throw new Error("source_content_grant_stale");
        }
        const output = await operation(client as PoolClient, requestedIds);
        await client.query(
          "UPDATE cp_source_content_read_grant SET consumed_at = $2 WHERE grant_id = $1",
          [row.grant_id, input.clock.now()],
        );
        return output;
      });
    },
  };
}
