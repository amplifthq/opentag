# Discord Setup

Use this guide when `opentag setup --platform discord` asks for Discord values.

## What You Need

- A Discord application with a bot user, created in the [Developer Portal](https://discord.com/developers/applications).
- The **Application ID** and **Public Key** from the application's General Information page.
- The **Bot Token** from the application's Bot page (Reset Token shows it once).
- The **channel ID** to bind (enable Developer Mode in Discord settings, then right-click the channel → Copy Channel ID).
- A public tunnel URL that forwards Discord interactions to your local OpenTag dispatcher (default port 3030).

## Create The Application And Bot

1. Open the [Developer Portal](https://discord.com/developers/applications) and create an application.
2. On the **Bot** page, click **Reset Token** and copy the bot token.
3. On the **Bot** page, make sure **Requires OAuth2 Code Grant** is **off** (otherwise the plain invite link fails with "Integration requires code grant").
4. Invite the bot to your server with minimal permissions:

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=84992
```

`permissions=84992` grants View Channels, Send Messages, Read Message History, and Embed Links.

Keep the bot token private. OpenTag stores it in the local config file and redacts it in `opentag status` and `opentag doctor`.

## Run OpenTag Setup

```bash
opentag setup \
  --platform discord \
  --discord-application-id <APPLICATION_ID> \
  --discord-channel-id <CHANNEL_ID>
```

Setup prompts for the public key and bot token. It saves:

- `platforms.discord.applicationId`
- `platforms.discord.publicKey`
- `platforms.discord.botToken`
- `platforms.discord.channelId`
- `platforms.discord.webhookPath` (default `/discord/interactions`)

It also binds the Discord channel to the local project so `/opentag` invocations in that channel route to the local runner.

## Register The Slash Command

Discord slash commands must be registered once per application. Guild commands appear instantly:

```bash
curl -X PUT "https://discord.com/api/v10/applications/<APPLICATION_ID>/guilds/<GUILD_ID>/commands" \
  -H "Authorization: Bot <BOT_TOKEN>" \
  -H "content-type: application/json" \
  -d '[{
    "name": "opentag",
    "description": "Ask OpenTag to run a coding task on your local agent",
    "type": 1,
    "options": [
      { "name": "prompt", "description": "What you want OpenTag to do", "type": 3, "required": true },
      { "name": "executor", "description": "Which agent to use", "type": 3, "required": false,
        "choices": [
          { "name": "codex", "value": "codex" },
          { "name": "claude-code", "value": "claude-code" },
          { "name": "echo (test)", "value": "echo" }
        ] }
    ]
  }]'
```

Find the guild (server) ID by right-clicking the server name with Developer Mode on, or via `GET /users/@me/guilds` with the bot token.

## Configure The Interactions Endpoint

Discord delivers interactions over a public HTTPS webhook. The endpoint is mounted on the local dispatcher, so the tunnel targets port 3030:

1. Start OpenTag first so the endpoint answers Discord's verification PING:

```bash
opentag start
```

2. Run a tunnel to the dispatcher:

```bash
cloudflared tunnel --url http://localhost:3030
```

3. In the Developer Portal → General Information, set **Interactions Endpoint URL** to:

```text
https://<your-tunnel-host>/discord/interactions
```

Discord verifies the URL with a signed PING when you save; OpenTag answers it automatically. If verification fails, check that `opentag start` is running and the public key matches.

Quick tunnels mint a new URL on every restart — update the Interactions Endpoint URL after restarting the tunnel.

## Test The Integration

In the bound channel, run:

```text
/opentag prompt: say hi executor: echo
```

OpenTag acknowledges in the channel, runs the request on the local runner, and edits the status message with the result. Switch `executor` to `codex` or `claude-code` (or omit it to use the repository default) for real coding runs. The bot may appear offline — that is normal; the interactions webhook does not require a gateway connection.

## Troubleshooting

- **"This interaction failed"**: the tunnel is down, the tunnel URL changed, or `opentag start` is not running.
- **Interactions Endpoint URL fails to save**: OpenTag is not reachable through the tunnel, or `platforms.discord.publicKey` does not match the application.
- **`/opentag` does not appear**: the slash command was not registered for this guild, or the bot was invited without the `applications.commands` scope.
- **Ack arrives but nothing else**: the bot token is missing or wrong (`opentag doctor` shows secret readiness), or the channel is not bound.
