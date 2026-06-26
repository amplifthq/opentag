# Adapter Authoring

OpenTag adapters bring new work apps into the same protocol loop:

```text
work app event -> OpenTagEvent -> dispatcher -> runner -> callback
```

Use this guide when adding a new GitHub-like, Slack-like, Lark-like, or webhook
surface. For runtime configuration, see [Configuration](./configuration.md).

## Adapter Types

OpenTag currently uses three adapter shapes:

| Adapter type | Purpose | Current examples |
| --- | --- | --- |
| Ingress normalizer | Converts a platform event into `OpenTagEvent` | `@opentag/github`, `@opentag/slack`, `@opentag/telegram` |
| Ingress app | Receives signed webhooks/events and calls the dispatcher | `apps/github-probot`, `apps/slack-events`, `apps/telegram-events` |
| Callback sink | Posts acknowledgement, progress, and final messages back to the source thread | `createGitHubCallbackSink`, `createSlackCallbackSink`, `createTelegramCallbackSink` |

Future app support should arrive through these adapters, not by adding a new
execution architecture. The dispatcher and runner contracts should stay shared.

## Boundary Rules

- Adapters translate platform shape into OpenTag protocol shape.
- Adapters should ignore ambient messages unless there is an explicit mention or
  command trigger.
- Adapters should not choose a local checkout directly. Bindings map work app
  containers to repositories and runners.
- Adapters should not execute agent code. Runners and executors own execution.
- Adapters should not bake one team's workflow method into core protocol fields.
  Put opinionated behavior in recipes or policy.
- Official adapters should use stable, provider-specific ids for events,
  callbacks, and thread keys.

## Core Schema Check

Before writing code, check whether `@opentag/core` already supports the provider:

- `SourceSchema` currently includes `github`, `slack`, `telegram`, `lark`, `cli`, and
  `webhook`.
- `ProviderSchema` currently includes `github`, `slack`, `telegram`, and `lark`.
- `CallbackRouteSchema` currently includes `github`, `slack`, `telegram`, `lark`, and
  `webhook`.
- `ContextPointerSchema` includes GitHub, Slack, Telegram, Lark, file, URL, and text
  pointers.

If the new app needs a new provider such as Linear, Jira, Teams, or Discord,
extend the core enums first. Do not emit strings that fail `OpenTagEventSchema`.

For prototypes that do not need a first-class provider yet, use an existing
supported provider only when it is semantically true. Avoid pretending a Jira
actor is a GitHub actor just to pass validation.

## Normalizer Checklist

An ingress normalizer should produce `OpenTagEvent | null`.

Return `null` when:

- the event is not a user-authored trigger;
- the mention targets another bot or agent;
- the command text is empty after removing the platform mention;
- the source container is not bound to a repository or allowed work context.

Populate these fields carefully:

| Field | Guidance |
| --- | --- |
| `id` | Stable and namespaced, for example `evt_lark_message_<id>` |
| `source` | Provider or generic source accepted by `SourceSchema` |
| `sourceEventId` | Raw platform event id |
| `receivedAt` | ISO timestamp from the platform event or ingress clock |
| `actor` | Provider identity, user id, handle, and organization/team id when available |
| `target` | Mention text, `agentId`, and optional executor hint |
| `command` | Use `parseOpenTagMention` for literal `@opentag`; use `commandFromRawText` after stripping platform mentions |
| `context` | Durable pointers to the issue, thread, message, file, URL, or text |
| `permissions` | Smallest permissions implied by the command |
| `callback` | Provider, callback URI, and stable `threadKey` when callbacks target a thread |
| `metadata` | Provider-specific ids needed for binding, routing, or debugging |

## Command Parsing

Use the shared command parser instead of inventing adapter-specific commands.

- Use `parseOpenTagMention(text)` when the source text contains literal
  `@opentag`.
- Use `commandFromRawText(text)` when the platform has already resolved the bot
  mention and you only have the command body.
- Preserve parser diagnostics in `command.parsed`; they help runners and audit
  views explain weak commands.
- Forward `executorHint` from parsed commands into `target.executorHint`.

Intent defaults:

| Intent | Typical permissions |
| --- | --- |
| `review`, `explain`, `investigate` | callback permission plus runner permission |
| `fix`, `run` | callback, runner, repo read/write, and PR permission when the surface supports code work |
| `unknown` | callback and runner only, unless policy upgrades it later |

## Context Pointers

Context pointers should point to the source material without copying more data
than needed:

- issue, PR, ticket, task, or thread URL;
- source comment or message URL;
- file, line, range, and URL references parsed from command flags;
- short text context only when the source app has no durable URL.

Set `visibility` to `public`, `private`, or `organization` based on the source
container. Do not mark private work as public just because the runner is local.

## Callback Routes

Callbacks are part of the adapter contract. A callback route must tell the
dispatcher where human-facing updates belong:

```ts
callback: {
  provider: "slack",
  uri: "https://slack.com/api/chat.postMessage",
  threadKey: "T123|C123|1710000000.000100"
}
```

Use `threadKey` whenever a platform needs more than a URL to route replies. The
Slack adapter encodes `teamId`, `channelId`, and `threadTs` for this reason.

Callback sinks should:

- post acknowledgement and final results to the source thread;
- keep routine progress audit-only unless the adapter policy says otherwise;
- treat provider response bodies as authoritative when the provider can return
  HTTP 200 with an error payload;
- be idempotent where possible, for example by updating one run comment instead
  of flooding a thread.

## Binding Model

Do not create a second execution model for chat surfaces. Chat adapters should
resolve to the same Project Target and runner bindings used by GitHub-shaped
runs.

Current Slack behavior is the model:

```json
{
  "teamId": "T123",
  "channelId": "C123",
  "owner": "acme",
  "repo": "demo"
}
```

That binding lets a Slack thread create a run against the `acme/demo` Project
Target, then the daemon claims it only if its Project Target binding allows it.

For a new app, define the smallest binding that maps the app container to the
work context owner. Examples:

| App surface | Likely binding |
| --- | --- |
| Lark chat | `chatId -> Project Target ref` |
| Linear project | `teamId/projectId -> Project Target ref` |
| Jira project | `siteId/projectKey -> Project Target ref` |
| Microsoft Teams channel | `tenantId/teamId/channelId -> Project Target ref` |

## Package Layout

Use the existing package split as the default:

```text
packages/<adapter>/
  src/index.ts
  src/normalize.ts
  src/render.ts
  test/normalize.test.ts
  test/render.test.ts

apps/<adapter>-events/
  src/index.ts
  src/app.ts
  test/app.test.ts
```

Keep SDK-specific dependencies in the adapter package or ingress app. Do not add
provider SDKs to `@opentag/core`.

## Minimal Normalizer Example

This example uses Lark because `lark` is already a supported provider in core.
A new provider should first extend the core enums.

```ts
import { commandFromRawText, type OpenTagEvent } from "@opentag/core";

type LarkMessageMentionInput = {
  eventId: string;
  messageId: string;
  chatId: string;
  userId: string;
  textAfterMention: string;
  receivedAt: string;
  binding: {
    owner: string;
    repo: string;
  };
};

export function normalizeLarkMessageMention(input: LarkMessageMentionInput): OpenTagEvent | null {
  const rawText = input.textAfterMention.trim();
  if (!rawText) return null;

  const command = commandFromRawText(rawText);

  return {
    id: `evt_lark_message_${input.eventId}`,
    source: "lark",
    sourceEventId: input.eventId,
    receivedAt: input.receivedAt,
    actor: {
      provider: "lark",
      providerUserId: input.userId,
      organizationId: input.chatId
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        kind: "lark.message",
        uri: `lark://chat/${input.chatId}/message/${input.messageId}`,
        visibility: "organization",
        title: "Lark message"
      }
    ],
    permissions: [
      { scope: "chat:postMessage", reason: "reply in the originating Lark thread" },
      { scope: "runner:local", reason: "execute the run on an approved runner" }
    ],
    callback: {
      provider: "lark",
      uri: `lark://chat/${input.chatId}/message/${input.messageId}`,
      threadKey: `${input.chatId}|${input.messageId}`
    },
    metadata: {
      chatId: input.chatId,
      messageId: input.messageId,
      repoProvider: "github",
      owner: input.binding.owner,
      repo: input.binding.repo
    }
  };
}
```

## Ingress App Checklist

The ingress app should:

1. Verify provider signatures or tokens before parsing the event.
2. Handle provider challenge requests, such as Slack `url_verification`.
3. Resolve the source container to a binding.
4. Call the normalizer.
5. Create the run through `@opentag/client`.
6. Return quickly to the provider.
7. Log ignored events with enough context to debug bindings without leaking
   secrets.

If the dispatcher has `OPENTAG_PAIRING_TOKEN`, the ingress app must pass the
same value as `OPENTAG_DISPATCHER_TOKEN`.

## Test Checklist

At minimum, add tests for:

- non-mentions are ignored;
- empty commands are ignored;
- explicit mentions create a valid `OpenTagEvent`;
- event ids and thread keys are stable;
- write-capable intents request write permissions only when intended;
- unbound containers do not create runs;
- callback rendering escapes or formats provider markdown correctly;
- provider API error payloads become failures, not silent successes.

Run the normal repo gates before opening a PR:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

For real provider testing, follow [Real integration smoke test](./real-integration-smoke-test.md).
