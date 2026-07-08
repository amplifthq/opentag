# Microsoft Teams Setup

Use this guide when `opentag setup --platform teams` asks for Microsoft Teams values.

OpenTag receives Microsoft Teams messages through a Bot Framework webhook. Teams only delivers activities over HTTPS, so this platform always needs a public HTTPS Messaging endpoint pointed at your local dispatcher (unlike Discord's default Gateway mode or Telegram's default polling mode).

## What You Need

- An Azure Bot resource (Bot Framework registration) in the [Azure Portal](https://portal.azure.com). The **F0 (free)** pricing tier is enough for development and testing.
- The bot's **Microsoft App ID** and a **client secret** (this is the `appPassword` OpenTag asks for).
- Optionally, a **Tenant ID** if you want the bot restricted to a single Microsoft 365 tenant.
- A dev tunnel (`devtunnel` or `ngrok`) to expose the local dispatcher's webhook endpoint while you develop.
- The bot installed into a **team** and added to the target **channel**.

## Create The Azure Bot Resource

1. Open the [Azure Portal](https://portal.azure.com) and create a new **Azure Bot** resource.
2. Choose the **F0** pricing tier for free development use (upgrade to **S1** only if you need production-scale message volume).
3. During creation, either create a new Microsoft App ID or use an existing Microsoft Entra ID app registration.
4. After creation, open the Bot resource's **Configuration** page and copy the **Microsoft App ID**.
5. On the same page (or under the app registration's **Certificates & secrets**), create a new **client secret**. Copy the secret value immediately — Azure only shows it once. This is the `appPassword` OpenTag stores.

Keep the client secret private. OpenTag stores it in the local config file and redacts it in `opentag status` and `opentag doctor`.

See Microsoft's official [Bot Framework registration quickstart](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) for the full walkthrough.

## Single-Tenant Vs Multi-Tenant

- **Multi-tenant** apps (the default) can be installed into any Microsoft 365 tenant. Leave `tenantId` unset.
- **Single-tenant** apps are restricted to one Microsoft Entra ID tenant. If your app registration is single-tenant, set `tenantId` to that tenant's ID so OpenTag validates inbound Bot Framework JWTs against the correct issuer.

Find the Tenant ID on the app registration's **Overview** page in Microsoft Entra ID.

## Expose The Local Dispatcher

Teams needs a public HTTPS URL for the bot's messaging endpoint. Start a dev tunnel pointed at the local dispatcher port (default `3030`):

```bash
devtunnel host -p 3030
# or
ngrok http 3030
```

Set the bot's **Messaging endpoint** (in the Azure Bot resource's **Configuration** page) to:

```text
https://<tunnel-host>/teams/messages
```

If you need a non-default endpoint path, add `--teams-webhook-path /your/path` during setup and use the matching URL when configuring the Messaging endpoint.

## Install The Bot Into A Team

1. Add the **Microsoft Teams** channel to the Azure Bot resource (under **Channels**).
2. Package and sideload (or publish through your org's app catalog) the Teams app manifest that references your Microsoft App ID, then add the app to the target **team**.
3. Add the bot to the specific **channel** you want OpenTag to listen on.

Org tenants often restrict custom app installation. If sideloading is disabled, ask a Teams admin to approve the app or enable custom app upload for your tenant.

## Run OpenTag Setup

```bash
opentag setup \
  --platform teams \
  --teams-app-id <microsoft-app-id> \
  --teams-app-password <client-secret> \
  --teams-tenant-id <tenant-id>
```

Omit `--teams-tenant-id` for a multi-tenant app.

The setup command saves:

- `platforms.teams.appId`
- `platforms.teams.appPassword`
- `platforms.teams.tenantId` (only when provided)
- `platforms.teams.webhookPath` (defaults to `/teams/messages`)

Start OpenTag:

```bash
opentag start
```

OpenTag prints:

```text
Teams local webhook: http://127.0.0.1:3030/teams/messages
Teams Messaging Endpoint URL: https://<your-tunnel-host>/teams/messages
```

## Bind And Test

Teams channel bindings are keyed on `(tenantId, conversationId)`, not on `channelId` alone — a team's default **General** channel can omit `channelId`, so `conversationId` is the reliable key:

```text
provider: teams
tenantId: <tenant_id>
conversationId: <conversation_id>
```

If the channel is not bound yet, OpenTag acknowledges inbound activities but cannot start a run. Bind the channel through the dispatcher API or local config, then in the target channel post:

```text
@OpenTag investigate this failing test
```

Expected behavior:

- Teams posts the activity to your Messaging endpoint over the dev tunnel.
- OpenTag validates the inbound Bot Framework JWT (JWKS, audience, and `serviceUrl` claim) before processing.
- The local runner starts against the bound checkout.
- OpenTag replies in the same Teams channel as a plain-text message.

To apply a suggested action, mention the bot with the action number:

```text
@OpenTag apply 1
```

Official references:

- [Bot Framework registration quickstart](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration)
- [Create a bot for Microsoft Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams)
- [Send proactive messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rest-api/send-proactive-messages)

## Current Scope (v1)

Supported now:

- CLI setup through `opentag setup --platform teams`.
- Bot Framework webhook ingest at `/teams/messages`, with inbound JWT validation (JWKS, audience, and `serviceUrl` claim).
- `@OpenTag` mention handling in **channel** conversations.
- `@OpenTag apply N` action routing.
- Plain-text channel replies.

Not yet implemented / out of scope for v1:

- Adaptive Cards or clickable Apply buttons.
- Personal chats and group chats (channels only).
- A standalone Teams events service — the webhook runs inside the local dispatcher.
