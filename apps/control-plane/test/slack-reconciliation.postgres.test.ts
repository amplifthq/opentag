import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor } from '@opentag/delivery-contract';
import { createSlackDeliveryAdapter, SlackObservationRateLimit } from '@opentag/slack';
import { createDurableJobQueue } from '../src/modules/jobs/index.js';
import { createPostgresDeliveryRepository } from '../src/modules/provider-delivery/repository.js';
import { createSlackDeliveryReconciler } from '../src/modules/provider-delivery/reconciliation.js';
import { createIsolatedPostgres, TEST_DATABASE_URL } from './postgres-fixture.js';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const owner = { runtimeOwnerId: 'control-plane', runtimeGeneration: 1, schemaGeneration: 1 };

describe.skipIf(!TEST_DATABASE_URL)('durable Slack message reconciliation', () => {
  let db: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeEach(async () => {
    db = await createIsolatedPostgres(); await db.migrate();
    await db.pool.query("INSERT INTO cp_organization(organization_id,display_name) VALUES('org','Test')");
    await db.pool.query(`INSERT INTO cp_runner(organization_id,runner_id,registration_generation,
      credential_generation,current_credential_id,capabilities,created_at,updated_at)
      VALUES('org','runner',1,1,'credential','[]',clock_timestamp(),clock_timestamp())`);
    await db.pool.query(`INSERT INTO cp_hosted_run(organization_id,run_id,admission_id,
      admission_operation_id,admission_digest,source_identity_digest,runner_id,executor_id,
      source_version_ref,source_content_ids,source_context_digest,queue_claim_deadline,
      permission_ceiling_digest,publication_mode,publication_policy_digest,completion_mode,
      completion_contract_digest,state,current_attempt_number,hosted_admission,
      admission_policy_snapshot,created_at,updated_at)
      VALUES('org','run','admission','admit',$1,$1,'runner','executor','source',ARRAY['content'],
      $1,clock_timestamp()+interval '8 hours',$1,'proposal_only',$1,'proposal_ready',$1,
      'queued',0,'{}','{}',clock_timestamp(),clock_timestamp())`, [hash('fixture')]);
    await db.pool.query(`INSERT INTO cp_slack_binding(organization_id,binding_id,installation_id,
      binding_digest,state,credential_generation,credential_generation_digest,route_identity,
      team_id,app_id,channel_id,bot_user_id,member_user_ids,signing_secret_ref,bot_token_ref,created_at,updated_at)
      VALUES('org','binding','installation',$1,'active',1,$2,'route','T1','A1','C1','U1',ARRAY['U2'],
      'env:TEST_SIGNING','env:TEST_BOT',clock_timestamp(),clock_timestamp())`, [hash('binding'), hash('generation')]);
  });
  afterEach(async () => { await db.close(); });

  async function fixture(mode: 'create' | 'update' = 'update') {
    const clock = { now: () => new Date() };
    const jobs = createDurableJobQueue({ pool: db.pool, clock, leaseDurationMs: 30_000, tokenFactory: randomUUID });
    const repository = createPostgresDeliveryRepository({ pool: db.pool, owner, leaseOwner: 'delivery', leaseSeconds: 30 });
    const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: 'org',
      sideEffectIntentId: 'intent_old', causalId: 'run', intentKind: 'delivery', operation: mode,
      deliveryKind: 'message', presentationDigest: hash('presentation'), projectionRevision: 1,
      projectionEventSequence: 0, projectionPurpose: mode === 'create' ? 'anchor_create' : 'anchor_update',
      provenance: { kind: 'business', runId: 'run', repositoryIdentityDigest: hash('repo'), authorityLineageDigest: hash('authority') },
      providerBinding: { bindingKind: 'established', providerId: 'slack', providerInstanceId: 'installation',
        bindingDigest: hash('binding'), providerPrincipalDigest: hash('U1'), principalAssurance: 'provider_verified',
        providerConfigGeneration: 1, providerConfigGenerationDigest: hash('generation'), lifecycle: 'active' },
      targetDigest: hash(JSON.stringify({ channelId: 'C1', teamId: 'T1', threadTs: '170.001' })),
      authorityKind: 'hosted_send_authority', authoritySnapshotDigest: hash('policy'),
      evidencePolicy: 'hosted_control', idempotencyKey: 'old', statusMessageId: 'status',
      scope: { kind: 'hosted_control', id: 'run' }, initialAttemptSequence: 1, createdAt: new Date().toISOString() });
    const request = { operation: mode === 'create'
      ? { kind: 'create_message' as const, channelId: 'C1', threadTs: '170.001' }
      : { kind: 'update_message' as const, channelId: 'C1', messageTs: '171.002', threadTs: '170.001' },
      presentation: { kind: 'message' as const, text: 'Running', textFormat: 'mrkdwn' as const } };
    const envelope = (value = intent) => ({ envelopeVersion: 1, providerRequest: request, phase: 'running',
      frozenDeadline: new Date(Date.now() + 3600_000).toISOString(), currentTruth: deliveryCurrentTruthDescriptor({ intent: value,
        owner: { organizationId: 'org', providerId: 'slack', providerInstanceId: 'installation',
          providerBindingDigest: hash('binding'), providerConfigGeneration: 1, providerConfigGenerationDigest: hash('generation'), ...owner } }) });
    let message: Record<string, unknown> = {};
    let visible = true;
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      if (options?.method === 'POST') {
        const sent = JSON.parse(String(options.body));
        message = { ...sent, user: 'U1', bot_id: 'B1', app_id: 'A1', ts: '171.002', thread_ts: '170.001' };
        delete message.channel;
        throw new TypeError('response lost after provider accepted update');
      }
      if (String(url).endsWith('/auth.test')) return Response.json({ ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' });
      return Response.json({ ok: true, messages: visible ? [message] : [], has_more: false });
    });
    const adapter = createSlackDeliveryAdapter({ ...intent.providerBinding, teamId: 'T1', appId: 'A1',
      resolveCredential: async () => 'fixture-token', fetchImpl });
    await repository.recordIntent(intent, envelope());
    const claim = (await repository.claimNext())!;
    const begun = (await repository.markBegin({ ...claim, installationBeginMarkerId: 'ib', installationBeginMarkerDigest: hash('ib'),
      scopeBeginMarkerId: 'sb', scopeBeginMarkerDigest: hash('sb') }))!;
    const result = await adapter.deliver({ intent, ...request });
    expect(result.outcome).toBe('outcome_unknown');
    await repository.settleOrReadTerminal({ ...begun, outcome: 'outcome_unknown',
      evidenceDigest: result.evidenceDigest, errorCode: 'transport_error' });
    const observe = vi.fn(async (value, native) => adapter.reconcile({ intent: value, ...native }));
    const worker = () => createSlackDeliveryReconciler({ pool: db.pool, jobs, owner, clock, observe });
    return { repository, jobs, worker, observe, fetchImpl, intent, envelope,
      hide: () => { visible = false; }, show: () => { visible = true; } };
  }

  it('observes without resending, atomically seals evidence, and releases a newer projection', async () => {
    const f = await fixture();
    await db.pool.query("UPDATE cp_hosted_run SET state='running' WHERE run_id='run'");
    const next = DeliveryIntentV2Schema.parse({ ...f.intent, sideEffectIntentId: 'intent_new', idempotencyKey: 'new', projectionRevision: 2 });
    await f.repository.recordIntent(next, f.envelope(next));
    expect(await f.repository.claimNext()).toBeNull();
    await f.worker().schedule();
    expect(await f.worker().schedule()).toBe(0);
    expect(await f.worker().processNext()).toEqual({ kind: 'reconciled' });
    const row = (await db.pool.query("SELECT state,reconciliation_receipt FROM cp_provider_delivery_intent WHERE intent_id='intent_old'")).rows[0];
    expect(row).toMatchObject({ state: 'accepted', reconciliation_receipt: {
      kind: 'slack_message_observation_v1', original: { outcome: 'outcome_unknown', errorCode: 'transport_error' },
      observation: { outcome: 'accepted', externalResourceId: '171.002' } } });
    expect((await db.pool.query("SELECT state FROM cp_job WHERE job_id='slack-observe:intent_old'")).rows).toEqual([{ state: 'succeeded' }]);
    expect(await f.worker().processNext()).toEqual({ kind: 'empty' });
    expect(f.observe).toHaveBeenCalledOnce();
    expect((await f.repository.claimNext())?.intentId).toBe('intent_new');
    expect(f.fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    await expect(db.pool.query("UPDATE cp_provider_delivery_intent SET reconciliation_receipt='{}' WHERE intent_id='intent_old'"))
      .rejects.toThrow();
  });

  it('wakes a deferred projection after observing its previously unknown anchor', async () => {
    const f = await fixture('create');
    await db.pool.query("UPDATE cp_hosted_run SET state='running' WHERE run_id='run'");
    await db.pool.query(`INSERT INTO cp_projection_deferred_revision(organization_id,run_id,
      projection_revision,anchor_intent_id,state,created_at) VALUES('org','run',2,'intent_old','pending',clock_timestamp())`);
    await f.worker().schedule();
    expect(await f.worker().processNext()).toEqual({ kind: 'reconciled' });
    expect((await db.pool.query("SELECT state FROM cp_projection_deferred_revision")).rows)
      .toEqual([{ state: 'woken' }]);
    expect((await db.pool.query("SELECT state FROM cp_job WHERE job_id='team-relay-anchor-wake:org:run:2'")).rows)
      .toEqual([{ state: 'pending' }]);
    expect(f.fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('rejects direct unknown-to-accepted rewrites without an observation lease', async () => {
    await fixture();
    await expect(db.pool.query(`UPDATE cp_provider_delivery_intent SET state='accepted',revision=revision+1,
      error_code=NULL,reconciliation_receipt='{}' WHERE intent_id='intent_old'`))
      .rejects.toThrow('delivery_observation_authority_invalid');
    expect((await db.pool.query("SELECT state,reconciliation_receipt FROM cp_provider_delivery_intent")).rows)
      .toEqual([{ state: 'outcome_unknown', reconciliation_receipt: null }]);
  });

  it('retains uncertainty and resumes the same durable obligation after restart', async () => {
    const f = await fixture(); f.hide();
    await f.worker().schedule();
    expect(await f.worker().processNext()).toEqual({ kind: 'unconfirmed' });
    expect((await db.pool.query("SELECT state,reconciliation_receipt FROM cp_provider_delivery_intent")).rows)
      .toEqual([{ state: 'outcome_unknown', reconciliation_receipt: null }]);
    expect(await f.worker().processNext()).toEqual({ kind: 'empty' });
    f.show();
    await db.pool.query("UPDATE cp_job SET available_at=clock_timestamp()-interval '1 second' WHERE job_id='slack-observe:intent_old'");
    expect(await f.worker().processNext()).toEqual({ kind: 'reconciled' });
    expect(f.fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('honors provider retry-after without retrying the write', async () => {
    const f = await fixture(); await f.worker().schedule();
    f.observe.mockRejectedValueOnce(new SlackObservationRateLimit(180_000));
    const before = Date.now();
    expect(await f.worker().processNext()).toEqual({ kind: 'unconfirmed' });
    const row = (await db.pool.query("SELECT available_at,last_error_code FROM cp_job WHERE job_id='slack-observe:intent_old'")).rows[0];
    expect(row.available_at.getTime()).toBeGreaterThanOrEqual(before + 180_000);
    expect(row.last_error_code).toBe('slack_observation_rate_limited');
    expect(f.fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it.each(['lease', 'binding'])('rejects an observation after %s authority changes during the read', async kind => {
    const f = await fixture();
    const original = f.observe.getMockImplementation()!;
    f.observe.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (kind === 'lease') await db.pool.query("UPDATE cp_job SET lease_token='replacement' WHERE job_id='slack-observe:intent_old'");
      else await db.pool.query("UPDATE cp_slack_binding SET state='disabled' WHERE binding_id='binding'");
      return result;
    });
    await f.worker().schedule();
    expect(await f.worker().processNext()).toEqual({ kind: 'stale_observation' });
    expect((await db.pool.query("SELECT state,reconciliation_receipt FROM cp_provider_delivery_intent")).rows)
      .toEqual([{ state: 'outcome_unknown', reconciliation_receipt: null }]);
  });

  it('rolls both receipt and delivery state back when job settlement fails', async () => {
    const f = await fixture(); await f.worker().schedule();
    await db.pool.query(`CREATE FUNCTION reject_observation_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.job_kind='provider-delivery.reconcile' AND NEW.state='succeeded' THEN
      RAISE EXCEPTION 'injected_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_observation_job BEFORE UPDATE ON cp_job FOR EACH ROW EXECUTE FUNCTION reject_observation_job()`);
    expect(await f.worker().processNext()).toEqual({ kind: 'unconfirmed' });
    expect((await db.pool.query("SELECT state,reconciliation_receipt FROM cp_provider_delivery_intent")).rows)
      .toEqual([{ state: 'outcome_unknown', reconciliation_receipt: null }]);
    await db.pool.query("DROP TRIGGER reject_observation_job ON cp_job; UPDATE cp_job SET available_at=clock_timestamp()-interval '1 second' WHERE job_id='slack-observe:intent_old'");
    expect(await f.worker().processNext()).toEqual({ kind: 'reconciled' });
    expect(f.fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
});
