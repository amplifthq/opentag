# Discord Setup

Use this guide when `opentag setup --platform discord` asks for Discord values.

OpenTag receives Discord slash-command interactions through Discord Gateway by default. No public tunnel is required in the default mode: the local dispatcher keeps a Gateway WebSocket connection open, receives `INTERACTION_CREATE`, acknowledges the interaction through Discord's HTTP callback API, starts local runs, and posts progress/final messages back to the originating channel.

HTTP Interactions Endpoint delivery is still available as an advanced mode when you want Discord to push interactions to a public HTTPS endpoint.

## What You Need

- A Discord application in the [Developer Portal](https://discord.com/developers/applications).
- A bot token from the **Bot** page for the Gateway connection and channel messages.
- A registered `/opentag` slash command.
- Optional for advanced webhook mode only: the application public key and a public HTTPS tunnel.

## Create Or Open The Discord Application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an application or open an existing one.
3. On **Bot**, create or reset the bot token and copy it.
4. For advanced webhook mode only, copy **Public Key** from **General Information**.

Keep the bot token private. OpenTag stores it in the local config file and redacts it in `opentag status` and `opentag doctor`.

## Run OpenTag Setup

Default Gateway mode:

```bash
opentag setup \
  --platform discord \
  --discord-bot-token <bot-token>
```

The setup command saves:

- `platforms.discord.mode` as `gateway`
- `platforms.discord.botToken`

## Register The Slash Command

Register a global or guild command named `opentag`. Guild commands update faster during testing.

OpenTag's Discord adapter accepts `/opentag <prompt>` and routes it into the same run lifecycle as other platforms. See Discord's [Application Commands](https://docs.discord.com/developers/interactions/application-commands) documentation for command registration endpoints and bot-token authorization.

Start OpenTag:

```bash
opentag start
```

OpenTag prints:

```text
Discord: using Gateway connection
Discord tunnel: not required in Gateway mode
```

Official references:

- [Interactions Overview](https://docs.discord.com/developers/interactions/overview)
- [Gateway `INTERACTION_CREATE`](https://docs.discord.com/developers/events/gateway-events#interaction-create)
- [Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)

## Advanced Webhook Mode

Use webhook mode only when you want Discord to push interactions to a public HTTPS URL:

```bash
opentag setup \
  --platform discord \
  --discord-mode webhook \
  --discord-public-key <application-public-key> \
  --discord-bot-token <bot-token>
```

If you need a non-default endpoint path, add `--discord-webhook-path /your/path`.

Start OpenTag and point a tunnel at the dispatcher:

```bash
ngrok http 3030
opentag start
```

OpenTag prints:

```text
Discord local interactions endpoint: http://127.0.0.1:3030/discord/interactions
Discord Interactions Endpoint URL: https://<your-tunnel-host>/discord/interactions
```

In the Developer Portal, open **General Information** and paste the public HTTPS URL into **Interactions Endpoint URL**.

Discord validates the URL by sending a PING interaction. OpenTag responds with PONG and verifies `X-Signature-Ed25519` plus `X-Signature-Timestamp` using the configured public key.

Official references:

- [Configuring an Interactions Endpoint URL](https://docs.discord.com/developers/interactions/overview#configuring-an-interactions-endpoint-url)
- [Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)

## Bind And Test

Discord channel bindings use:

```text
provider: discord
accountId: <application_id>
conversationId: <channel_id>
```

If the channel is not bound yet, OpenTag will acknowledge the command but cannot start a run. Bind the channel through the dispatcher API or local config, then run:

```text
/opentag investigate this failing test
```

Expected behavior:

- Discord sends the slash command through Gateway mode or webhook mode.
- OpenTag acknowledges quickly.
- The local runner starts against the bound checkout.
- OpenTag posts or edits a status/final message in the same Discord channel.

## Current Scope

Supported now:

- CLI setup through `opentag setup --platform discord`.
- Default Gateway-based `INTERACTION_CREATE` handling with no public tunnel.
- Advanced local dispatcher Interactions Endpoint at `/discord/interactions`.
- Slash-command interaction handling.
- Webhook-mode signature verification with the Discord application public key.
- Bot-token channel replies and status-message edit chains.
- Typed source-thread actions routed through Discord component callbacks when present.

Not yet implemented:

- Automatic slash-command registration.
- Gateway `@mention` support.
- Source-thread `/bind` self-service from Discord.
- Hosted relay mode for Discord.
