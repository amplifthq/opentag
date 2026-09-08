import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import { canonicalJsonStringify } from '@opentag/control-protocol/canonical-json';
import { SlackObservationRateLimit } from '@opentag/slack';
import { DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor, domainSeparatedCanonicalBytes,
  type DeliveryIntentV2, type ProviderDeliveryResult } from '@opentag/delivery-contract';
import type { DurableJobQueue } from '../jobs/index.js';
import { withPostgresTransaction, type PostgresTransactionClient } from '../../database/postgres.js';

const KIND = 'provider-delivery.reconcile';
const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Payload = z.object({ intentId: z.string().min(1).max(512), intentDigest: digest }).strict();
const Observation = z.object({ outcome: z.literal('accepted'), evidenceDigest: digest,
  externalResourceId: z.string().regex(/^\d{1,20}\.\d{1,20}$/u), externalResourceDigest: digest }).strict();
type Row = { intent_id: string; organization_id: string; journal_intent_digest: string;
  payload_digest: string; intent: unknown; payload: unknown; revision: number;
  error_code: string; evidence_digest: string; outcome_recorded_at: Date;
  current_truth_key: string; channel_id: string; team_id: string; app_id: string; bot_user_id: string };
type Owner = { runtimeOwnerId: string; runtimeGeneration: number; schemaGeneration: number };

// Source binding is read again under lock at settlement: rotation/disable during
// an observation cannot turn an obsolete worker into current authority.
const selection = `SELECT delivery.intent_id,delivery.organization_id,delivery.journal_intent_digest,
  delivery.payload_digest,delivery.intent,delivery.payload,delivery.revision,
  delivery.error_code,delivery.evidence_digest,delivery.outcome_recorded_at,
  delivery.current_truth_key,binding.channel_id,binding.team_id,binding.app_id,binding.bot_user_id
  FROM cp_provider_delivery_intent delivery
  JOIN cp_slack_binding binding ON binding.organization_id=delivery.organization_id
    AND binding.installation_id=delivery.provider_instance_id
    AND binding.binding_digest=delivery.provider_binding_digest
    AND binding.credential_generation=delivery.provider_config_generation
    AND binding.credential_generation_digest=delivery.provider_config_generation_digest
    AND delivery.intent->'providerBinding'->>'providerPrincipalDigest'
      ='sha256:'||encode(sha256(convert_to(binding.bot_user_id,'UTF8')),'hex')
    AND binding.state='active'
  WHERE delivery.state='outcome_unknown' AND delivery.provider_id='slack'
    AND delivery.runtime_owner_id=$1 AND delivery.runtime_generation=$2 AND delivery.schema_generation=$3
    AND delivery.projection_purpose IN ('anchor_create','anchor_update')`;

function hydrate(row: Row, owner: Owner) {
  const intent = DeliveryIntentV2Schema.parse(row.intent);
  const payload = z.object({ envelopeVersion: z.literal(1),
    phase: z.enum(['received', 'running', 'terminal']), frozenDeadline: z.iso.datetime({ offset: true }),
    providerRequest: z.object({ operation: z.object({
      kind: z.enum(['create_message', 'update_message']), channelId: z.string().min(1),
      messageTs: z.string().optional(), threadTs: z.string().optional(),
    }).strict(), presentation: z.object({ kind: z.literal('message'), text: z.string(),
      textFormat: z.enum(['markdown','mrkdwn']).optional(), blocks: z.array(z.unknown()).optional() }).strict(),
    }).strict(), currentTruth: z.unknown(),
  }).strict().parse(row.payload);
  const binding = intent.providerBinding;
  const expectedTruth = deliveryCurrentTruthDescriptor({ intent, owner: {
    organizationId: intent.organizationId, providerId: binding.providerId,
    providerInstanceId: binding.providerInstanceId, providerBindingDigest: binding.bindingDigest,
    providerConfigGeneration: binding.providerConfigGeneration,
    providerConfigGenerationDigest: binding.providerConfigGenerationDigest, ...owner } });
  if (intent.sideEffectIntentId !== row.intent_id || intent.organizationId !== row.organization_id
    || payload.providerRequest.operation.channelId !== row.channel_id
    || !payload.providerRequest.operation.threadTs
    || intent.targetDigest !== hash(canonicalJsonStringify({ teamId: row.team_id,
      channelId: row.channel_id, threadTs: payload.providerRequest.operation.threadTs }))
    || row.journal_intent_digest !== hash(domainSeparatedCanonicalBytes('opentag.delivery.journal-intent.v1', intent))
    || row.payload_digest !== hash(domainSeparatedCanonicalBytes('opentag.delivery.provider-payload.v1', payload))
    || hash(domainSeparatedCanonicalBytes('opentag.delivery.current-truth.v1', payload.currentTruth))
      !== hash(domainSeparatedCanonicalBytes('opentag.delivery.current-truth.v1', expectedTruth))) {
    throw new Error('slack_observation_custody_mismatch');
  }
  return { intent, request: payload.providerRequest };
}

export function createSlackDeliveryReconciler(input: {
  pool: Pool; jobs: DurableJobQueue; owner: Owner; clock: { now(): Date };
  observe(intent: DeliveryIntentV2, request: object): Promise<ProviderDeliveryResult>;
}) {
  const ownerValues = [input.owner.runtimeOwnerId, input.owner.runtimeGeneration, input.owner.schemaGeneration];
  const read = (organizationId: string, intentId: string, client?: PostgresTransactionClient) => {
    const sql = `${selection} AND delivery.organization_id=$4 AND delivery.intent_id=$5
      ${client ? 'FOR UPDATE OF delivery FOR SHARE OF binding' : ''}`;
    const values = [...ownerValues, organizationId, intentId];
    return client ? client.query<Row>(sql, values) : input.pool.query<Row>(sql, values);
  };
  return {
    async schedule() {
      return withPostgresTransaction(input.pool, async client => {
        const rows = await client.query<Row>(`${selection}
          AND NOT EXISTS (SELECT 1 FROM cp_job job WHERE job.job_id='slack-observe:'||delivery.intent_id)
          ORDER BY delivery.updated_at,delivery.intent_id LIMIT 50`, ownerValues);
        for (const row of rows.rows) await input.jobs.enqueueInTransaction(client, {
          jobId: `slack-observe:${row.intent_id}`, organizationId: row.organization_id, kind: KIND,
          payload: { intentId: row.intent_id, intentDigest: row.journal_intent_digest }, maxAttempts: 100,
        });
        return rows.rows.length;
      });
    },
    async processNext() {
      const claimed = await input.jobs.claim('slack-observation', [KIND]);
      if (claimed.kind === 'empty') return { kind: 'empty' } as const;
      const { job } = claimed;
      try {
        const value = Payload.parse(job.payload);
        if (!job.organizationId) throw new Error('slack_observation_scope_missing');
        const row = (await read(job.organizationId, value.intentId)).rows[0];
        if (!row || row.journal_intent_digest !== value.intentDigest) {
          await input.jobs.fail({ jobId: job.jobId, leaseToken: job.leaseToken,
            errorCode: 'slack_observation_authority_changed' });
          return { kind: 'authority_changed' } as const;
        }
        const hydrated = hydrate(row, input.owner);
        const observed = Observation.safeParse(await input.observe(hydrated.intent, hydrated.request));
        if (!observed.success) throw new Error('slack_observation_unconfirmed');
        if (hydrated.request.operation.kind === 'update_message'
          && observed.data.externalResourceId !== hydrated.request.operation.messageTs) {
          throw new Error('slack_observation_target_mismatch');
        }
        const expectedResource = hash(`opentag.delivery.external-resource.v1\0slack\0${hydrated.intent.providerBinding.providerInstanceId}\0${observed.data.externalResourceId}`);
        if (observed.data.externalResourceDigest !== expectedResource) throw new Error('slack_observation_target_mismatch');
        const settled = await withPostgresTransaction(input.pool, async client => {
          const at = input.clock.now();
          const lease = await client.query(`SELECT 1 FROM cp_job WHERE job_id=$1 AND organization_id=$2
            AND job_kind=$3 AND state='claimed' AND lease_token=$4 AND lease_expires_at>$5 FOR UPDATE`,
          [job.jobId, job.organizationId, KIND, job.leaseToken, at]);
          if (!lease.rowCount) return false;
          await client.query('SELECT 1 FROM cp_provider_delivery_truth_lock WHERE current_truth_key=$1 FOR UPDATE', [row.current_truth_key]);
          const current = (await read(job.organizationId!, value.intentId, client)).rows[0];
          if (!current || current.revision !== row.revision
            || current.team_id !== row.team_id || current.app_id !== row.app_id
            || current.channel_id !== row.channel_id || current.bot_user_id !== row.bot_user_id
            || current.journal_intent_digest !== value.intentDigest || current.payload_digest !== row.payload_digest) return false;
          hydrate(current, input.owner);
          const receipt = { kind: 'slack_message_observation_v1', jobId: job.jobId,
            jobLeaseDigest: hash(job.leaseToken), intentDigest: value.intentDigest,
            observedAt: at.toISOString(), observation: observed.data,
            original: { outcome: 'outcome_unknown', evidenceDigest: row.evidence_digest,
              errorCode: row.error_code, recordedAt: row.outcome_recorded_at.toISOString() } };
          await client.query(`UPDATE cp_provider_delivery_intent SET state='accepted',revision=revision+1,
            evidence_digest=$2,error_code=NULL,external_resource_id=$3,external_resource_digest=$4,
            outcome_recorded_at=$5,updated_at=$5,reconciliation_receipt=$6 WHERE intent_id=$1`,
          [row.intent_id, observed.data.evidenceDigest, observed.data.externalResourceId,
            observed.data.externalResourceDigest, at, receipt]);
          await client.query(`UPDATE cp_job SET state='succeeded',lease_owner=NULL,lease_token=NULL,
            lease_expires_at=NULL,last_error_code=NULL,settlement_lease_token=$2,settlement_outcome=$3,
            settled_at=$4,updated_at=$4 WHERE job_id=$1`, [job.jobId, job.leaseToken,
            { kind: 'slack_message_observed', intentId: row.intent_id, evidenceDigest: observed.data.evidenceDigest }, at]);
          return true;
        });
        if (!settled) await input.jobs.fail({ jobId: job.jobId, leaseToken: job.leaseToken,
          errorCode: 'slack_observation_authority_changed' });
        return { kind: settled ? 'reconciled' : 'stale_observation' } as const;
      } catch (error) {
        // Never persist provider text, credential material or raw response errors.
        const throttled = error instanceof SlackObservationRateLimit;
        const delay = Math.max(throttled ? error.retryAfterMs : 0,
          Math.min(900_000, 60_000 * 2 ** Math.min(job.attemptCount - 1, 4)));
        const result = await input.jobs.fail({ jobId: job.jobId, leaseToken: job.leaseToken,
          errorCode: throttled ? 'slack_observation_rate_limited' : 'slack_observation_unconfirmed',
          // Unusable provider retry windows stop this job, not the unknown record.
          ...(Number.isSafeInteger(delay) && delay <= 7 * 86_400_000
            ? { retryAt: new Date(input.clock.now().getTime() + delay) } : {}) });
        return { kind: result.kind === 'retry_scheduled' ? 'unconfirmed' : result.kind } as const;
      }
    },
  };
}
