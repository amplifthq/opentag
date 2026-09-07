import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryIntentV2Schema } from '@opentag/delivery-contract';
import { createSlackDeliveryAdapter } from '../src/delivery-adapter.js';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: 'org_test',
  sideEffectIntentId: 'intent_1', causalId: 'run_1', intentKind: 'delivery', operation: 'update',
  deliveryKind: 'message', presentationDigest: digest('presentation'), projectionRevision: 7,
  projectionEventSequence: 2, projectionPurpose: 'anchor_update',
  provenance: { kind: 'business', runId: 'run_1', repositoryIdentityDigest: digest('repo'),
    authorityLineageDigest: digest('authority') }, providerBinding: { bindingKind: 'established',
    providerId: 'slack', providerInstanceId: 'installation_1', bindingDigest: digest('binding'),
    providerPrincipalDigest: digest('U_BOT'), principalAssurance: 'provider_verified',
    providerConfigGeneration: 1, providerConfigGenerationDigest: digest('generation'), lifecycle: 'active' },
  targetDigest: digest('target'), authorityKind: 'hosted_send_authority', authoritySnapshotDigest: digest('policy'),
  evidencePolicy: 'hosted_control', idempotencyKey: 'idempotency_1', statusMessageId: 'status_1',
  scope: { kind: 'hosted_control', id: 'run_1' }, initialAttemptSequence: 1,
  createdAt: '2026-09-07T00:00:00.000Z' });

function fixture() {
  let message: Record<string, unknown> = {};
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init?.body));
      message = { ...body, ts: '171.002', thread_ts: '170.001', user: 'U_BOT', bot_id: 'B_BOT', app_id: 'A_APP' };
      delete message.channel;
      return Response.json({ ok: true, ts: '171.002' });
    }
    if (String(url).endsWith('/auth.test')) return Response.json({ ok: true, team_id: 'T_TEAM', user_id: 'U_BOT', bot_id: 'B_BOT' });
    return Response.json({ ok: true, messages: [message], has_more: false });
  });
  const adapter = createSlackDeliveryAdapter({ ...intent.providerBinding,
    teamId: 'T_TEAM', appId: 'A_APP', resolveCredential: async () => 'fixture-token', fetchImpl });
  const input = { intent, operation: { kind: 'update_message' as const,
    channelId: 'C_CHANNEL', messageTs: '171.002', threadTs: '170.001' },
    presentation: { kind: 'message' as const, text: 'OpenTag: Running', textFormat: 'mrkdwn' as const,
      blocks: [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: 'Running' } }] } };
  return { adapter, input, fetchImpl, mutate: (change: (value: Record<string, unknown>) => void) => change(message) };
}

describe('Slack read-only message observation', () => {
  it('recognizes an exact sent version using only GET and authenticates the expected bot', async () => {
    const f = fixture(); await f.adapter.deliver(f.input);
    const posted = JSON.parse(String(f.fetchImpl.mock.calls[0]![1]!.body));
    expect(posted.metadata.event_type).toBe('opentag_projection_v1');
    expect(posted.metadata.event_payload.receipt).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(posted.metadata)).not.toContain('org_test');
    f.mutate(value => { value.blocks = [{ type: 'section', block_id: 'generated',
      text: { type: 'mrkdwn', text: 'Running', verbatim: false } }]; });
    f.fetchImpl.mockClear();
    await expect(f.adapter.reconcile(f.input)).resolves.toMatchObject({ outcome: 'accepted', externalResourceId: '171.002' });
    expect(f.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname))
      .toEqual(['/api/auth.test', '/api/conversations.replies']);
    expect(f.fetchImpl.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it.each(['text', 'blocks', 'metadata', 'user', 'bot_id', 'app_id', 'ts', 'thread_ts'])
    ('keeps unknown when observed %s differs', async field => {
      const f = fixture(); await f.adapter.deliver(f.input);
      f.mutate(value => { value[field] = field === 'blocks' ? [] : 'different'; });
      await expect(f.adapter.reconcile(f.input)).resolves.toMatchObject({ outcome: 'outcome_unknown' });
      expect(f.fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    });

  it('requires the exact intent version, target and frozen presentation, not merely the same text', async () => {
    const f = fixture(); await f.adapter.deliver(f.input);
    for (const change of [{ projectionRevision: 8 }, { projectionEventSequence: 3 },
      { sideEffectIntentId: 'intent_other' }, { targetDigest: digest('other') },
      { presentationDigest: digest('other') }]) {
      await expect(f.adapter.reconcile({ ...f.input, intent: DeliveryIntentV2Schema.parse({ ...intent, ...change }) }))
        .resolves.toMatchObject({ outcome: 'outcome_unknown' });
    }
  });

  it('does not infer success from missing messages, throttling, or wrong token workspace', async () => {
    const f = fixture(); await f.adapter.deliver(f.input);
    f.fetchImpl.mockImplementationOnce(async () => Response.json({ ok: true, team_id: 'OTHER', user_id: 'U_BOT', bot_id: 'B_BOT' }));
    await expect(f.adapter.reconcile(f.input)).resolves.toMatchObject({ outcome: 'outcome_unknown' });
    f.fetchImpl.mockImplementationOnce(async () => new Response('', { status: 429 }));
    await expect(f.adapter.reconcile(f.input)).rejects.toMatchObject({ retryAfterMs: 60_000 });
    f.mutate(value => { delete value.metadata; });
    await expect(f.adapter.reconcile(f.input)).resolves.toMatchObject({ outcome: 'outcome_unknown' });
  });

  it('recovers a created reply only from a complete, unique thread observation', async () => {
    const f = fixture();
    const input = { ...f.input, intent: DeliveryIntentV2Schema.parse({ ...intent,
      operation: 'create', projectionPurpose: 'anchor_create' }),
      operation: { kind: 'create_message' as const, channelId: 'C_CHANNEL', threadTs: '170.001' } };
    await f.adapter.deliver(input);
    await expect(f.adapter.reconcile(input)).resolves.toMatchObject({ outcome: 'accepted' });
    let message: unknown;
    f.mutate(value => { message = structuredClone(value); });
    for (const response of [{ messages: [message, message], has_more: false },
      { messages: [message], has_more: true }]) {
      f.fetchImpl.mockResolvedValueOnce(Response.json({ ok: true, team_id: 'T_TEAM', user_id: 'U_BOT', bot_id: 'B_BOT' }))
        .mockResolvedValueOnce(Response.json({ ok: true, ...response }));
      await expect(f.adapter.reconcile(input)).resolves.toMatchObject({ outcome: 'outcome_unknown' });
    }
    expect(f.fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
});
