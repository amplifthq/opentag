import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withPostgresTransaction } from "../../database/postgres.js";

export const hashGrantToken = (token: string) => createHash("sha256")
  .update(token, "utf8").digest("hex");

export type SourceContentReadGrant = { grantId: string; token: string };

type GrantRow = {
  grant_id: string; organization_id: string; token_hash: string; run_id: string;
  attempt_id: string; fence_digest: string; content_ids: string[]; purpose: string;
  expires_at: Date; consumed_at: Date | null; revoked_at: Date | null;
};

const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
export const normalizeContentIds = (ids: readonly string[]) =>
  [...new Set(ids)].sort();

export function createSourceContentGrantStore(input: {
  pool: Pool; clock: { now(): Date }; tokenFactory?: () => string;
}) {
  const tokenFactory = input.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  return {
    async issue(command: {
      organizationId: string; runId: string; attemptId: string; fenceDigest: string;
      contentIds: string[]; purpose: string; expiresAt: Date;
    }): Promise<SourceContentReadGrant> {
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
      const token = tokenFactory();
      const grantId = `source_grant_${randomBytes(16).toString("hex")}`;
      await withPostgresTransaction(input.pool, async (client) => {
        const locked = await client.query<{ content_id: string }>(
          `SELECT content_id FROM cp_source_content
           WHERE organization_id = $1 AND content_id = ANY($2::text[])
             AND purpose = $3 AND deleted_at IS NULL AND expires_at > $4
           ORDER BY content_id FOR UPDATE`,
          [command.organizationId, contentIds, command.purpose, input.clock.now()],
        );
        if (!same(locked.rows.map((row) => row.content_id), contentIds)) {
          throw new Error("source_content_unavailable");
        }
        await client.query(
          `INSERT INTO cp_source_content_read_grant(
             grant_id, organization_id, token_hash, run_id, attempt_id,
             fence_digest, content_ids, purpose, expires_at, created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [grantId, command.organizationId, hashGrantToken(token), command.runId,
            command.attemptId, command.fenceDigest, contentIds, command.purpose,
            command.expiresAt, input.clock.now()],
        );
      });
      return { grantId, token };
    },

    async consume<T>(command: {
      grantId: string; token: string; organizationId: string; runId: string;
      attemptId: string; fenceDigest: string; contentIds: string[]; purpose: string;
    }, operation: (client: PoolClient, contentIds: string[]) => Promise<T>): Promise<T> {
      return withPostgresTransaction(input.pool, async (client) => {
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
