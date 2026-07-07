# Microsoft Teams Adapter — Design

Date: 2026-07-07
Status: Approved design, ready for implementation planning

## Goal

Add Microsoft Teams as a new OpenTag platform adapter so a user can `@OpenTag`
inside a Teams team channel, have OpenTag run a local coding agent, and get the
reply back in the same thread — using the same dispatcher/runner/binding loop as
every other platform.

## Scope (v1)

- **Team channels only.** `conversation.conversationType === "channel"`. Personal
  (1:1) and group chats are out of scope for v1 and are ignored.
- **Trigger: @mention.** A `message` activity that mentions the bot, e.g.
  `@OpenTag investigate this`. No slash command in v1.
- **Reply rendering: plain text / Markdown.** No Adaptive Cards in v1. Action
  receipts are shown as text; `apply`/`approve` is triggered by re-mentioning the
  bot (`@OpenTag apply 1`), not a clickable button. Adaptive Cards deferred to v2.
- **Connection: Bot Framework webhook.** Teams has no persistent-gateway
  equivalent (unlike Discord), so a public HTTPS endpoint is required. Local dev
  uses a dev tunnel (e.g. `devtunnel` / `ngrok`).

## Architecture

Follow the **Discord package shape**: a self-contained `packages/teams` mounted
directly into the `local-runtime` dispatcher process. There is **no**
`apps/teams-events` service (matching Discord, unlike Slack/Telegram/Lark).

The Discord package is the closest reference for **skeleton and wiring**, but the
inbound / auth / outbound layers are **rewritten for Teams**, not copied —
Discord's webhook path is a slash-command interaction with a 3-second ACK and a
static Ed25519 body signature, none of which apply to a Teams message activity.

### Package layout

```
packages/teams/
  src/
    auth.ts             # Validate inbound Bot Framework JWT (JWKS + audience + issuer + serviceUrl)
    token.ts            # Outbound: App ID + secret -> OAuth2 client-credentials access token (cached/refreshed)
    normalize.ts        # Teams message Activity (with @mention entity) -> OpenTagEvent
    thread-key.ts       # Encode/decode serviceUrl|conversationId|activityId
    render.ts           # OpenTag result / receipt -> Teams Markdown text
    connector.ts        # POST/PUT {serviceUrl}/v3/conversations/{conversationId}/activities (uses token.ts)
    webhook-app.ts      # Hono app: receive Activity -> 200 OK -> (deferred) strip mention, normalize, call dispatcher
    index.ts
  test/
    auth.test.ts / normalize.test.ts / thread-key.test.ts / render.test.ts / webhook-app.test.ts
  package.json / tsconfig.json / tsup.config.ts / README.md
```

### Inbound data flow

```
Teams channel: @OpenTag investigate this
  -> Bot Framework
  -> POST /teams/messages (Hono app mounted in dispatcher)
  -> auth.ts validates the Bot Framework JWT          (NOT an Ed25519 static public key)
  -> respond 200 OK immediately                        (NO Discord-style 3-second type-4 ACK)
  -> (deferred) strip @mention entity -> commandFromRawText -> normalizeTeamsActivity() -> OpenTagEvent
  -> dispatcher -> runner -> local Codex / Claude Code
```

### Outbound data flow

```
render.ts produces Markdown
  -> token.ts obtains an access token (App ID + secret)    (NOT a static bot token)
  -> connector.ts POST (first) / PUT (subsequent edits) to
     {serviceUrl}/v3/conversations/{conversationId}/activities[/{activityId}]
```

### Changes outside packages/teams

- `packages/core/src/capability.ts`: add `"teams"` to `OpenTagPlatformId` and a
  capability descriptor (`livenessStrategy: "webhook"`,
  `requiresExplicitAddressing: true`, etc.).
- `packages/local-runtime/src/dispatcher.ts`: add a Teams `if`-block that mounts
  the webhook app (`app.route(...)`) and registers `createTeamsCallbackSink`,
  mirroring the Discord webhook branch.
- `packages/cli`: extend `catalogs/platforms.ts` (`PlatformId`, catalog entry,
  guide-file map, `parsePlatformId`) and `setup/*` (`types.ts`, `flow.ts`,
  `builders.ts`, `defaults.ts`, `guides.ts`, `summary.ts`) to collect Teams
  credentials; add `platforms/teams/display.ts` and touch the readiness/status
  surfaces the Discord PR touched.
- `docs/platforms/teams.en.md` + `teams.zh-CN.md`, and register them in the
  platform table / `PLATFORM_SETUP_GUIDE_FILES`.

## Inbound normalization

### Example inbound Activity (mentioning the bot in a channel)

```jsonc
{
  "type": "message",
  "id": "1699...",                        // activityId
  "text": "<at>OpenTag</at> investigate this",
  "serviceUrl": "https://smba.trafficmanager.net/amer/",   // reply base URL, per-tenant
  "from": { "id": "29:1...", "name": "Alice", "aadObjectId": "a1b2..." },
  "recipient": { "id": "28:<botAppId>", "name": "OpenTag" },  // the bot itself
  "conversation": { "id": "19:...@thread.tacv2", "conversationType": "channel", "tenantId": "t1" },
  "channelData": {
    "tenant":  { "id": "t1" },
    "team":    { "id": "19:team..." },
    "channel": { "id": "19:chan..." }
  },
  "entities": [
    { "type": "mention", "mentioned": { "id": "28:<botAppId>" }, "text": "<at>OpenTag</at>" }
  ]
}
```

### `normalizeTeamsActivity` rules — return `null` when

1. `type !== "message"`.
2. `conversation.conversationType !== "channel"` (personal / groupChat out of scope for v1).
3. `text` is absent/empty (cards or attachment-only activities).
4. No `mention` entity whose `mentioned.id === recipient.id` (the bot was not addressed).
5. The message is self-authored or bot-authored (`from.id === recipient.id`, or a bot sender) — defence-in-depth even though rule 4 already blocks it.
6. After stripping the mention entity's `text` from `text` and trimming, the command body is empty.

### Emitted `OpenTagEvent`

```jsonc
{
  "id": "evt_teams_<activityId>",
  "source": "teams",
  "sourceEventId": "<activityId>",
  "receivedAt": "<activity timestamp or ingress clock>",
  "actor": {
    "provider": "teams",
    "providerUserId": "<from.aadObjectId ?? from.id>",
    "handle": "<from.name>",
    "organizationId": "<teamId>"
  },
  "target": { "mention": "@opentag", "agentId": "opentag" /* executorHint optional */ },
  "command": /* commandFromRawText(strippedText) */,
  "context": [
    {
      "provider": "teams",
      "kind": "message",
      "uri": "teams://team/<teamId>/channel/<channelId>/message/<activityId>",
      "visibility": "organization",
      "title": "Teams message"
    }
    /* plus contextPointersForCommand(command) — reused from the Discord adapter */
  ],
  "permissions": /* permissionsForIntent(command.intent) — reused shape */,
  "callback": {
    "provider": "teams",
    "uri": "<serviceUrl>",
    "threadKey": "<serviceUrl>|<conversationId>|<activityId>"
  },
  "metadata": {
    "tenantId": "t1",
    "teamId": "19:team...",
    "channelId": "19:chan...",
    "conversationId": "19:...@thread.tacv2",
    "serviceUrl": "https://smba.trafficmanager.net/amer/",
    "repoProvider": "github",
    "owner": "<binding.owner>",
    "repo": "<binding.repo>"
  }
}
```

Reuse from the Discord adapter with minimal change: `permissionsForIntent`,
`contextPointersForCommand`, `commandMetadata`, and the intent → write-permission
mapping (`fix`/`run` add `repo:read` / `repo:write` / `pr:create`).

## Binding model

Key the dispatcher-side binding on **`(tenantId, conversationId)`**.

```jsonc
{
  "tenantId": "t1",
  "teamId": "19:team...",
  "channelId": "19:chan...",       // display/audit only
  "conversationId": "19:...@thread.tacv2",
  "owner": "acme",
  "repo": "demo"
}
```

- **Why `conversationId`, not `channelId`:** the team's default (General) channel
  frequently omits `channelData.channel.id`, in which case the channel id equals
  the team id. `conversation.id` is always present and unique for a channel
  conversation, so it is the reliable binding key. `channelId`/`teamId` are still
  stored for display and audit.
- Unbound conversation → the handler declines to run and posts a one-line
  "not bound" notice back to the conversation (mirrors the Discord unbound branch).

## serviceUrl handling

- **Inbound:** read `serviceUrl` from the Activity; store it as the first segment
  of `threadKey` and in `metadata.serviceUrl`.
- **Outbound:** the callback sink decodes `threadKey` back into
  `serviceUrl` + `conversationId` and posts to
  `{serviceUrl}/v3/conversations/{conversationId}/activities`.
- **Delimiter safety:** `threadKey` uses `|`. `serviceUrl` (a URL) and
  `conversationId` (e.g. `19:...@thread.tacv2;messageid=<root>`) contain no `|`,
  so the split is unambiguous — same convention as the Discord thread key.
- Threaded reply position depends on `conversation.id` carrying `;messageid=`;
  storing `conversation.id` verbatim is correct. Verify exact thread placement
  during the real-integration smoke test.

## Inbound authentication (`auth.ts`)

Bot Framework does **not** sign the request body (unlike Discord's Ed25519, which
covers the body). Inbound trust rests entirely on the JWT bearer token in the
`Authorization` header, so every check below is mandatory — omitting any one is a
vulnerability:

1. Validate the JWT signature against the Bot Framework **JWKS**
   (`https://login.botframework.com/v1/.well-known/openidconfiguration` → signing
   keys), with key caching and rotation.
2. **`audience` must equal our `appId`** (otherwise another bot's token is
   accepted).
3. Validate the **issuer**.
4. Validate that the JWT's **`serviceUrl` claim matches the `serviceUrl` in the
   body**, because the body `serviceUrl` is used as the outbound target — this
   prevents redirection to a forged endpoint.

Failure → `401`, before any normalization.

## Outbound token (`token.ts`)

```
POST https://login.microsoftonline.com/{tenantId || "botframework.com"}/oauth2/v2.0/token
  grant_type = client_credentials
  client_id  = appId
  client_secret = appPassword
  scope      = https://api.botframework.com/.default
```

Cache the access token and refresh before expiry.

## Callback sink (`createTeamsCallbackSink`)

Follows the Discord sink's **edit-chain** convention
(`packages/dispatcher/src/callbacks.ts`): POST the first message, then update the
same message for later progress/final. State (`existingActivityId`) is in-memory
per run within the long-lived dispatcher process — **no store/ledger change
needed**.

1. Decode `callback.threadKey` → `serviceUrl` + `conversationId` + `activityId`.
2. Obtain an access token via `token.ts` (cached).
3. First message: `POST {serviceUrl}/v3/conversations/{conversationId}/activities`
   with `{ type: "message", text: <rendered Markdown> }`; capture the returned
   activity id.
4. Subsequent progress/final: `PUT
   {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}` to edit
   the same message in place.
5. **Provider errors are failures, not silent successes.** Any non-2xx from the
   Connector (expired token, invalid conversation, `403` bot-not-installed) is
   thrown into `onBackgroundError`; a transient error on one update must not
   permanently break the edit chain for later updates of the same run.

## Actions (apply / approve N)

- In `webhook-app.ts`, after stripping the mention, run the command body through
  `parseThreadActionCommand` (as Discord does). If it matches → call
  `submitThreadAction`, **do not create a run**. If `submitThreadAction` is not
  configured → reply "thread actions are not supported on this dispatcher".
- Because v1 replies are plain text (no Adaptive Card buttons), `apply`/`approve`
  is triggered by the user re-mentioning the bot (`@OpenTag apply 1`). Action
  receipts are shown as text ("can apply" / "needs setup" / "safest current
  decision"), consistent with early Slack/Telegram behaviour. Card buttons are a
  v2 concern.

## Error handling

| Scenario | Behaviour |
| --- | --- |
| Invalid / missing JWT (bad signature, wrong audience, wrong issuer, serviceUrl mismatch) | `401`, no normalization |
| Body over size limit | Stream-read to the cap, then `413` (reuse `readRequestTextWithLimit`) |
| Non-channel conversation / non-message / not mentioning the bot / empty command | `200`, no run (normal ignore) |
| Unbound conversation | `200`, then post a "not bound" notice to the conversation |
| Deferred binding/run/action failure | `onBackgroundError` (default `console.error`) + optional failure notice to the conversation |
| Outbound token failure / Connector non-2xx (incl. `403` bot-not-installed) | Thrown into the sink's error channel, never a silent success |

## Testing

Adapter unit/normalize tests (`packages/teams/test`):

- non-`message` activity → `null`
- `message` but not mentioning the bot → `null`
- mentions the bot but empty after stripping mention → `null`
- `text` absent → `null`
- personal / groupChat conversation → `null` (v1 scope)
- normal @mention → valid `OpenTagEvent`; `id` and `threadKey` stable
- General channel (`channelData.channel.id` absent) still parses; binding key
  falls to `conversationId`
- `fix` / `run` intents add `repo:write` / `pr:create`; others do not
- unbound conversation does not create a run
- `threadKey` encode/decode round-trip (including `serviceUrl`)
- rendered Markdown escapes/formats correctly
- Connector non-2xx → failure, not silent success
- inbound JWT with wrong `audience` → `401`
- body over limit → `413`

Real provider testing follows `docs/real-integration-smoke-test.md`; verify the
reply lands in the correct channel thread.

Repo gates before PR: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

## Explicit non-goals (v1)

- Adaptive Cards / clickable Apply buttons (v2).
- Personal (1:1) and group chats.
- Any persistent-gateway / socket transport (Teams has none; webhook only).
- A standalone `apps/teams-events` service.
