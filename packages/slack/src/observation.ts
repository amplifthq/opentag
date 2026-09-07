import { DeliveryIntentV2Schema, domainSeparatedCanonicalBytes,
  type DeliveryIntentV2, type ProviderDeliveryResult } from '@opentag/delivery-contract';
import type { SlackDeliveryOperation } from './delivery-adapter.js';

export class SlackObservationRateLimit extends Error {
  constructor(readonly retryAfterMs: number) { super('slack_observation_rate_limited'); }
}

const digest = async (value: Uint8Array) => `sha256:${Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>)),
  byte => byte.toString(16).padStart(2, '0')).join('')}`;
const hash = (value: unknown) => digest(domainSeparatedCanonicalBytes('opentag.slack.observation.v1', value));
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

export const slackExternalResourceDigest = (instance: string, id: string) => digest(new TextEncoder()
  .encode(`opentag.delivery.external-resource.v1\0slack\0${instance}\0${id}`));

export async function slackObservationMarker(input: DeliveryIntentV2, payload: object) {
  const parsed = DeliveryIntentV2Schema.safeParse(input);
  if (!parsed.success || !('projectionRevision' in parsed.data)
    || parsed.data.projectionRevision === undefined || input.deliveryKind !== 'message') return undefined;
  return { event_type: 'opentag_projection_v1', event_payload: { receipt: await hash({
    intent: parsed.data, payload,
  }) } };
}

// Ignore only Slack-generated block IDs and default text flags, not requested fields.
function contentMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, index) => contentMatches(actual[index], value));
  const wanted = record(expected); const observed = record(actual);
  if (!wanted) return actual === expected;
  if (!observed) return false;
  if (!Object.entries(wanted).every(([key, value]) => contentMatches(observed[key], value))) return false;
  return Object.keys(observed).every(key => key in wanted
    || (key === 'block_id' && typeof observed[key] === 'string' && typeof wanted.type === 'string')
    || (key === 'emoji' && wanted.type === 'plain_text' && observed[key] === true)
    || (key === 'verbatim' && wanted.type === 'mrkdwn' && observed[key] === false));
}

export async function observeSlackMessage(input: {
  intent: DeliveryIntentV2; operation: SlackDeliveryOperation; payload: object;
  teamId: string; appId: string; principalDigest: string;
  resolveCredential(signal: AbortSignal): Promise<string>;
  fetchImpl: typeof fetch; deadlineMs: number;
}): Promise<ProviderDeliveryResult> {
  const unknown = async (reason: string): Promise<ProviderDeliveryResult> => ({ outcome: 'outcome_unknown',
    evidenceDigest: await hash({ reason }), errorCode: 'ambiguous_response' });
  const marker = await slackObservationMarker(input.intent, input.payload);
  const operation = input.operation;
  if (!marker || operation.kind === 'add_reaction'
    || (operation.kind === 'create_message' && !operation.threadTs)) return unknown('unobservable_identity');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([new Promise<ProviderDeliveryResult>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('observation_timeout')); }, input.deadlineMs);
    }), (async () => {
      const token = await input.resolveCredential(controller.signal);
      const get = async (method: string, params: Record<string, string>) => {
        const url = new URL(`https://slack.com/api/${method}`);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const response = await input.fetchImpl(url.toString(), { method: 'GET',
          headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
        if (response.status === 429) {
          const seconds = Number(response.headers.get('retry-after') ?? '60');
          throw new SlackObservationRateLimit(Number.isSafeInteger(seconds) && seconds > 0
            ? Math.max(60_000, seconds * 1_000) : 60_000);
        }
        if (!response.ok) throw new Error('observation_unavailable');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('observation_unavailable');
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2_000_000) { await reader.cancel(); throw new Error('observation_too_large'); }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const value = record(JSON.parse(new TextDecoder().decode(bytes)));
        if (!value || value.ok !== true) throw new Error('observation_unavailable');
        return value;
      };
      const identity = await get('auth.test', {});
      if (identity.team_id !== input.teamId || typeof identity.user_id !== 'string'
        || await digest(new TextEncoder().encode(identity.user_id)) !== input.principalDigest
        || typeof identity.bot_id !== 'string') return unknown('principal_mismatch');
      const threadTs = operation.threadTs;
      const body = await get(threadTs ? 'conversations.replies' : 'conversations.history', {
        channel: operation.channelId, include_all_metadata: 'true', limit: '100',
        ...(threadTs ? { ts: threadTs,
          ...(operation.kind === 'update_message' ? { oldest: operation.messageTs,
            latest: operation.messageTs, inclusive: 'true', limit: '2' } : {}),
        } : { oldest: operation.kind === 'update_message'
          ? operation.messageTs : '', inclusive: 'true', limit: '1' }),
      });
      if (!Array.isArray(body.messages) || (body.channel !== undefined && body.channel !== operation.channelId))
        return unknown('target_unverified');
      if (operation.kind === 'create_message' && (body.has_more === true
        || record(body.response_metadata)?.next_cursor)) return unknown('incomplete_observation');
      const expected = record(input.payload)!;
      // Slack can flatten newlines in the accessibility fallback for Block Kit
      // messages. The blocks and marker must still match the frozen originals.
      const textMatches = (text: unknown) => text === expected.text
        || (Array.isArray(expected.blocks) && expected.blocks.length > 0
          && typeof expected.text === 'string' && text === expected.text.replace(/\n/gu, ' '));
      const matches = body.messages.map(record).filter(message => message
        && typeof message.ts === 'string' && /^\d{1,20}\.\d{1,20}$/u.test(message.ts)
        && (operation.kind !== 'update_message' || message.ts === operation.messageTs)
        && (!threadTs || message.thread_ts === threadTs)
        && message.user === identity.user_id && message.bot_id === identity.bot_id
        && message.app_id === input.appId && contentMatches(message.metadata, marker)
        && textMatches(message.text) && contentMatches(message.blocks ?? [], expected.blocks ?? [])
        && (!message.attachments || (Array.isArray(message.attachments) && message.attachments.length === 0)));
      if (matches.length !== 1) return unknown('message_version_or_content_mismatch');
      const ts = matches[0]!.ts as string;
      return { outcome: 'accepted' as const,
        evidenceDigest: await hash({ marker, teamId: input.teamId, appId: input.appId,
          channelId: operation.channelId, ts, observedAt: new Date().toISOString() }),
        externalResourceId: ts,
        externalResourceDigest: await slackExternalResourceDigest(input.intent.providerBinding.providerInstanceId, ts) };
    })()]);
  } catch (error) {
    if (error instanceof SlackObservationRateLimit) throw error;
    return unknown('observation_unavailable');
  }
  finally { controller.abort(); clearTimeout(timer); }
}
