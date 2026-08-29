import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  withPostgresTransaction,
  type PostgresTransactionClient,
} from "../../database/postgres.js";
import { decryptSourceContent, digest, encryptSourceContent,
  type RelayContentKey, type SourceContentContext } from "./crypto.js";
import { createSourceContentGrantStore } from "./grants.js";
export type { SourceContentReadGrant } from "./grants.js";

export type SourceContextEnvelopeRef = {
  contentId: string; sourceVersionRef: string; aadDigest: string; keyVersion: string;
};

const boundedIdentity = z.string().min(1).max(512).refine((value) => value === value.trim());
const sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const boundedIsoDateTime = z.string().max(64).pipe(z.iso.datetime({ offset: true }));

export const VerifiedSourceWithdrawalCommandSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("verified_source_withdrawal"),
  commandId: boundedIdentity,
  organizationId: boundedIdentity,
  sourceVersionRef: boundedIdentity,
  verification: z.object({
    installationId: boundedIdentity,
    sourceAppId: boundedIdentity,
    sourceDeliveryId: boundedIdentity,
    verifiedAt: boundedIsoDateTime,
    evidenceDigest: sha256Digest,
  }).strict(),
}).strict();

export type VerifiedSourceWithdrawalCommand = z.infer<
  typeof VerifiedSourceWithdrawalCommandSchema
>;

export const ImmutableInvalidationReceiptSchema = z.object({
  commandId: boundedIdentity,
  organizationId: boundedIdentity,
  sourceVersionRef: boundedIdentity,
  reason: z.literal("source_content_deleted"),
  recordedAt: boundedIsoDateTime,
  authorityReceiptDigest: sha256Digest,
}).strict();

export type ImmutableInvalidationReceipt = Readonly<z.infer<
  typeof ImmutableInvalidationReceiptSchema
>>;

export interface SourceContentInvalidationAuthority {
  invalidate(input: {
    organizationId: string; sourceVersionRef: string; contentIds: string[];
    reason: "source_content_deleted"; commandId: string;
  }): Promise<unknown>;
}

export class SourceContentInvalidationAuthorityTransientError extends Error {
  constructor() {
    super("source_invalidation_authority_transient");
    this.name = "SourceContentInvalidationAuthorityTransientError";
  }
}

export function parseVerifiedSourceWithdrawalCommand(
  input: unknown,
): VerifiedSourceWithdrawalCommand {
  try {
    const parsed = VerifiedSourceWithdrawalCommandSchema.parse(input);
    return Object.freeze({
      ...parsed,
      verification: Object.freeze({ ...parsed.verification }),
    });
  } catch {
    throw new Error("source_withdrawal_verification_invalid");
  }
}

function parseInvalidationReceipt(
  input: unknown,
  expected: Pick<VerifiedSourceWithdrawalCommand,
    "commandId" | "organizationId" | "sourceVersionRef">,
): ImmutableInvalidationReceipt {
  try {
    const parsed = ImmutableInvalidationReceiptSchema.parse(input);
    if (parsed.commandId !== expected.commandId
      || parsed.organizationId !== expected.organizationId
      || parsed.sourceVersionRef !== expected.sourceVersionRef
      || parsed.reason !== "source_content_deleted") {
      throw new Error("mismatch");
    }
    return Object.freeze({ ...parsed });
  } catch {
    throw new Error("source_invalidation_receipt_invalid");
  }
}

type ContentRow = {
  organization_id: string; content_id: string; installation_id: string;
  source_app_id: string; source_delivery_id: string; source_message_id: string;
  source_version_ref: string; purpose: string; ciphertext: Buffer | null;
  content_nonce: Buffer | null; content_tag: Buffer | null; wrapped_dek: Buffer | null;
  wrapping_nonce: Buffer | null; wrapping_tag: Buffer | null; aad_digest: string;
  key_version: string; expires_at: Date; terminal_at: Date | null; deleted_at: Date | null;
};

const contextFromRow = (row: ContentRow): SourceContentContext => ({
  organizationId: row.organization_id, contentId: row.content_id,
  installationId: row.installation_id, sourceAppId: row.source_app_id,
  sourceDeliveryId: row.source_delivery_id, sourceMessageId: row.source_message_id,
  sourceVersionRef: row.source_version_ref, purpose: row.purpose,
});
const replayDigest = (context: SourceContentContext) => digest([
  "opentag.relay.source-replay/v1", context.organizationId, context.installationId,
  context.sourceAppId, context.sourceDeliveryId, context.sourceMessageId,
  context.sourceVersionRef, context.purpose, context.contentId,
]);
const sourceVersionDigest = (organizationId: string, sourceVersionRef: string) =>
  digest(["opentag.relay.source-version/v1", organizationId, sourceVersionRef]);

function decryptRow(row: ContentRow, key: RelayContentKey): unknown {
  if (row.deleted_at || !row.ciphertext || !row.content_nonce || !row.content_tag
    || !row.wrapped_dek || !row.wrapping_nonce || !row.wrapping_tag) {
    throw new Error("source_content_deleted");
  }
  const plaintext = decryptSourceContent({ key, context: contextFromRow(row),
    ciphertext: row.ciphertext, contentNonce: row.content_nonce, contentTag: row.content_tag,
    wrappedDek: row.wrapped_dek, wrappingNonce: row.wrapping_nonce,
    wrappingTag: row.wrapping_tag, aadDigest: row.aad_digest, keyVersion: row.key_version });
  try { return JSON.parse(plaintext.toString("utf8")); }
  catch { throw new Error("source_content_decryption_failed"); }
  finally { plaintext.fill(0); }
}

export function createRelayContentCustody(input: {
  pool: Pool; clock: { now(): Date }; key: RelayContentKey;
  invalidationAuthority?: SourceContentInvalidationAuthority;
  tokenFactory?: () => string;
}) {
  const grants = createSourceContentGrantStore(input);
  const storeInTransaction = async (
    client: PostgresTransactionClient,
    command: SourceContentContext & { payload: unknown; expiresAt: Date },
  ): Promise<SourceContextEnvelopeRef> => {
    const fields = [command.organizationId, command.installationId, command.sourceAppId,
      command.sourceDeliveryId, command.sourceMessageId, command.sourceVersionRef,
      command.purpose, command.contentId];
    if (fields.some((field) => !field || field.length > 512)
      || !Number.isFinite(command.expiresAt.getTime())
      || command.expiresAt.getTime() <= input.clock.now().getTime()) {
      throw new Error("source_content_invalid");
    }
    let serialized: string;
    try {
      const candidate = JSON.stringify(command.payload);
      if (candidate === undefined) throw new Error("invalid");
      serialized = candidate;
    } catch {
      throw new Error("source_content_invalid");
    }
    const plaintext = Buffer.from(serialized, "utf8");
    if (plaintext.length > 256 * 1024) {
      plaintext.fill(0);
      throw new Error("source_content_too_large");
    }
    const encrypted = encryptSourceContent({ key: input.key, context: command, plaintext });
    plaintext.fill(0);
    const identityDigest = replayDigest(command);
    const tombstone = await client.query(
      `SELECT 1 FROM cp_source_replay_tombstone
       WHERE organization_id = $1
         AND (replay_identity_digest = $2 OR source_version_digest = $3)
         AND expires_at > $4`,
      [command.organizationId, identityDigest,
        sourceVersionDigest(command.organizationId, command.sourceVersionRef),
        input.clock.now()],
    );
    if (tombstone.rows[0]) throw new Error("source_content_replayed");
    try {
      await client.query(
        `INSERT INTO cp_source_content(
          organization_id, content_id, installation_id, source_app_id,
          source_delivery_id, source_message_id, source_version_ref, purpose,
          ciphertext, content_nonce, content_tag, wrapped_dek, wrapping_nonce,
          wrapping_tag, aad_digest, key_version, expires_at, created_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [command.organizationId, command.contentId, command.installationId,
          command.sourceAppId, command.sourceDeliveryId, command.sourceMessageId,
          command.sourceVersionRef, command.purpose, encrypted.ciphertext,
          encrypted.contentNonce, encrypted.contentTag, encrypted.wrappedDek,
          encrypted.wrappingNonce, encrypted.wrappingTag, encrypted.aadDigest,
          encrypted.keyVersion, command.expiresAt, input.clock.now()],
      );
    } catch {
      throw new Error("source_content_conflict");
    }
    return { contentId: command.contentId, sourceVersionRef: command.sourceVersionRef,
      aadDigest: encrypted.aadDigest, keyVersion: encrypted.keyVersion };
  };
  return {
    async checkReadiness() {
      if (input.key.key.length !== 32 || !input.key.keyVersion) {
        return { ready: false, reason: "configuration_invalid" } as const;
      }
      try {
        const result = await input.pool.query<ContentRow>(
          "SELECT * FROM cp_source_content WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1",
        );
        if (result.rows[0]) decryptRow(result.rows[0], input.key);
        return { ready: true } as const;
      } catch {
        return { ready: false, reason: "configuration_invalid" } as const;
      }
    },

    storeInTransaction,
    async store(command: SourceContentContext & { payload: unknown; expiresAt: Date }) {
      return withPostgresTransaction(input.pool, (client) => storeInTransaction(client, command));
    },

    issueReadGrant: grants.issue,
    issueReadGrantInTransaction: grants.issueInTransaction,
    async read(command: Parameters<typeof grants.consume>[0]) {
      return grants.consume(command, async (client, contentIds) => {
        const result = await client.query<ContentRow>(
          `SELECT * FROM cp_source_content WHERE organization_id = $1
             AND content_id = ANY($2::text[]) ORDER BY content_id FOR UPDATE`,
          [command.organizationId, contentIds],
        );
        if (result.rows.length !== contentIds.length) throw new Error("source_content_unavailable");
        return result.rows.map((row) => {
          if (row.purpose !== command.purpose) throw new Error("source_content_context_mismatch");
          return { contentId: row.content_id, payload: decryptRow(row, input.key) };
        });
      });
    },

    async addDependency(command: { organizationId: string; contentId: string;
      sourceVersionRef: string; dependencyId: string; terminal: boolean }) {
      await withPostgresTransaction(input.pool, async (client) => {
        const content = await client.query(
          `SELECT 1 FROM cp_source_content WHERE organization_id = $1
             AND content_id = $2 AND source_version_ref = $3 FOR UPDATE`,
          [command.organizationId, command.contentId, command.sourceVersionRef],
        );
        if (!content.rows[0]) throw new Error("source_content_unavailable");
        await client.query(
          `INSERT INTO cp_source_content_dependency(organization_id, content_id,
            source_version_ref, dependency_id, terminal, created_at)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (organization_id, content_id, dependency_id)
           DO UPDATE SET terminal = cp_source_content_dependency.terminal OR EXCLUDED.terminal`,
          [command.organizationId, command.contentId, command.sourceVersionRef,
            command.dependencyId, command.terminal, input.clock.now()],
        );
        const state = await client.query<{ all_terminal: boolean }>(
          `SELECT bool_and(terminal) AS all_terminal
           FROM cp_source_content_dependency WHERE organization_id = $1 AND content_id = $2`,
          [command.organizationId, command.contentId],
        );
        await client.query(
          `UPDATE cp_source_content SET terminal_at = CASE WHEN $3
             THEN COALESCE(terminal_at, $4) ELSE NULL END
           WHERE organization_id = $1 AND content_id = $2`,
          [command.organizationId, command.contentId,
            state.rows[0]?.all_terminal === true, input.clock.now()],
        );
      });
    },

    async markDependencyTerminal(command: { organizationId: string; contentId: string;
      dependencyId: string }) {
      await withPostgresTransaction(input.pool, async (client) => {
        const content = await client.query(
          `SELECT 1 FROM cp_source_content WHERE organization_id = $1
             AND content_id = $2 FOR UPDATE`,
          [command.organizationId, command.contentId],
        );
        if (!content.rows[0]) throw new Error("source_content_unavailable");
        const dependency = await client.query(
          `UPDATE cp_source_content_dependency SET terminal = true
           WHERE organization_id = $1 AND content_id = $2 AND dependency_id = $3
           RETURNING dependency_id`,
          [command.organizationId, command.contentId, command.dependencyId],
        );
        if (!dependency.rows[0]) throw new Error("source_content_dependency_unavailable");
        const remaining = await client.query(
          `SELECT 1 FROM cp_source_content_dependency WHERE organization_id = $1
             AND content_id = $2 AND terminal = false LIMIT 1`,
          [command.organizationId, command.contentId],
        );
        if (!remaining.rows[0]) await client.query(
          `UPDATE cp_source_content SET terminal_at = COALESCE(terminal_at, $3)
           WHERE organization_id = $1 AND content_id = $2`,
          [command.organizationId, command.contentId, input.clock.now()],
        );
      });
    },

    async withdraw(inputCommand: VerifiedSourceWithdrawalCommand) {
      const command = parseVerifiedSourceWithdrawalCommand(inputCommand);
      const requestDigest = digest(["opentag.relay.source-withdrawal/v1",
        command.organizationId, command.sourceVersionRef, command.commandId]);
      return withPostgresTransaction(input.pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          sourceVersionDigest(command.organizationId, command.sourceVersionRef),
        ]);
        const existing = await client.query<{ request_digest: string | null;
          invalidation_receipt: ImmutableInvalidationReceipt | null }>(
          `SELECT request_digest, invalidation_receipt FROM cp_source_replay_tombstone
           WHERE organization_id = $1 AND command_id = $2 FOR UPDATE`,
          [command.organizationId, command.commandId],
        );
        const replay = existing.rows[0];
        if (replay) {
          if (replay.request_digest !== requestDigest) throw new Error("source_withdrawal_conflict");
          if (replay.invalidation_receipt) {
            return parseInvalidationReceipt(replay.invalidation_receipt, command);
          }
        }
        const versionReplay = await client.query<{ command_id: string | null }>(
          `SELECT command_id FROM cp_source_replay_tombstone
           WHERE organization_id = $1 AND source_version_digest = $2
             AND expires_at > $3 FOR UPDATE`,
          [command.organizationId,
            sourceVersionDigest(command.organizationId, command.sourceVersionRef),
            input.clock.now()],
        );
        if (!replay && versionReplay.rows[0]) throw new Error("source_withdrawal_conflict");
        const rows = await client.query<ContentRow>(
          `SELECT * FROM cp_source_content WHERE organization_id = $1
            AND source_version_ref = $2 ORDER BY content_id`,
          [command.organizationId, command.sourceVersionRef],
        );
        const contentIds = rows.rows.map((row) => row.content_id);
        if (contentIds.length === 0 && !replay) throw new Error("source_content_unavailable");
        if (rows.rows.some((row) => row.installation_id !== command.verification.installationId
          || row.source_app_id !== command.verification.sourceAppId
          || row.source_delivery_id !== command.verification.sourceDeliveryId)) {
          throw new Error("source_withdrawal_verification_invalid");
        }
        if (!input.invalidationAuthority) throw new Error("source_invalidation_unavailable");
        let authorityOutput: unknown;
        try {
          authorityOutput = await input.invalidationAuthority!.invalidate({
            organizationId: command.organizationId, sourceVersionRef: command.sourceVersionRef,
            contentIds, reason: "source_content_deleted", commandId: command.commandId,
          });
        } catch (error) {
          throw new Error(
            error instanceof SourceContentInvalidationAuthorityTransientError
              ? "source_invalidation_transient"
              : "source_invalidation_failed",
          );
        }
        const receipt = parseInvalidationReceipt(authorityOutput, command);
        const lockedRows = await client.query<ContentRow>(
          `SELECT * FROM cp_source_content WHERE organization_id = $1
            AND source_version_ref = $2 ORDER BY content_id FOR UPDATE`,
          [command.organizationId, command.sourceVersionRef],
        );
        if (lockedRows.rows.map((row) => row.content_id).join("\u0000")
          !== contentIds.join("\u0000")) {
          throw new Error("source_content_unavailable");
        }
        await client.query(
          `UPDATE cp_source_content SET ciphertext = NULL, content_nonce = NULL,
             content_tag = NULL, wrapped_dek = NULL, wrapping_nonce = NULL,
             wrapping_tag = NULL, deleted_at = COALESCE(deleted_at, $3)
           WHERE organization_id = $1 AND source_version_ref = $2`,
          [command.organizationId, command.sourceVersionRef, input.clock.now()],
        );
        if (contentIds.length > 0) await client.query(
          `UPDATE cp_source_content_read_grant SET revoked_at = COALESCE(revoked_at, $3)
           WHERE organization_id = $1 AND content_ids && $2::text[] AND consumed_at IS NULL`,
          [command.organizationId, contentIds, input.clock.now()],
        );
        if (!replay) {
          const first = rows.rows[0]!;
          await client.query(
            `INSERT INTO cp_source_replay_tombstone(organization_id,
              replay_identity_digest, source_version_digest, command_id,
              request_digest, invalidation_receipt, created_at, expires_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [command.organizationId, replayDigest(contextFromRow(first)),
              sourceVersionDigest(command.organizationId, command.sourceVersionRef),
              command.commandId, requestDigest, receipt, input.clock.now(),
              new Date(input.clock.now().getTime() + 90 * 86_400_000)],
          );
        }
        return receipt;
      });
    },

    async markTerminal(command: { organizationId: string; contentId: string }) {
      await withPostgresTransaction(input.pool, async (client) => {
        const result = await client.query(
          `SELECT 1 FROM cp_source_content WHERE organization_id = $1
             AND content_id = $2 FOR UPDATE`,
          [command.organizationId, command.contentId],
        );
        if (!result.rows[0]) throw new Error("source_content_unavailable");
        const nonterminal = await client.query(
          `SELECT 1 FROM cp_source_content_dependency WHERE organization_id = $1
             AND content_id = $2 AND terminal = false LIMIT 1`,
          [command.organizationId, command.contentId],
        );
        if (nonterminal.rows[0]) throw new Error("source_content_nonterminal");
        await client.query(
          `UPDATE cp_source_content SET terminal_at = COALESCE(terminal_at, $3)
           WHERE organization_id = $1 AND content_id = $2`,
          [command.organizationId, command.contentId, input.clock.now()],
        );
      });
    },

    async purge() {
      return withPostgresTransaction(input.pool, async (client) => {
        const cutoff = new Date(input.clock.now().getTime() - 7 * 86_400_000);
        const rows = await client.query<ContentRow>(
          `SELECT * FROM cp_source_content
           WHERE terminal_at IS NOT NULL AND terminal_at <= $1
           ORDER BY organization_id, content_id FOR UPDATE`,
          [cutoff],
        );
        for (const row of rows.rows) await client.query(
          `INSERT INTO cp_source_replay_tombstone(organization_id,
             replay_identity_digest, source_version_digest, created_at, expires_at)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT (organization_id, replay_identity_digest)
           DO UPDATE SET expires_at = GREATEST(cp_source_replay_tombstone.expires_at, EXCLUDED.expires_at)`,
          [row.organization_id, replayDigest(contextFromRow(row)),
            sourceVersionDigest(row.organization_id, row.source_version_ref), input.clock.now(),
            new Date(input.clock.now().getTime() + 90 * 86_400_000)],
        );
        if (rows.rows.length > 0) await client.query(
          `DELETE FROM cp_source_content WHERE (organization_id, content_id) IN
           (SELECT organization_id, content_id FROM cp_source_content
            WHERE terminal_at IS NOT NULL AND terminal_at <= $1)`,
          [cutoff],
        );
        const expired = await client.query(
          "DELETE FROM cp_source_replay_tombstone WHERE expires_at <= $1",
          [input.clock.now()],
        );
        return { purged: rows.rows.length, tombstonesExpired: expired.rowCount ?? 0 };
      });
    },
  };
}

export type RelayContentCustody = ReturnType<typeof createRelayContentCustody>;
