# Slack Setup

Use this guide when `opentag setup` asks for Slack credentials.

OpenTag supports two Slack connection modes:

- **Local Socket Mode**: recommended for running OpenTag on this computer. No public URL is required.
- **Public Events API**: best for hosted OpenTag, or advanced local testing with a tunnel.

Both modes support the same core product flow: mention the Slack app, let OpenTag run a local coding agent, and get the result back in the same Slack thread.

Slack-only setup proves the Slack loop. It does not by itself grant GitHub write access. If a run proposes a pull request action, `apply 1` can create a GitHub PR only when OpenTag also has a GitHub repository target and GitHub token configured.

## Official Links

- [Slack app settings](https://api.slack.com/apps)
- [Slack app quickstart](https://docs.slack.dev/quickstart/)
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack OAuth scopes](https://api.slack.com/scopes)

## Recommended: Local Socket Mode

Choose this mode when you want `opentag start` on your computer to receive Slack mentions directly.

### What You Need

- A Slack app installed in your workspace.
- Socket Mode enabled for that app.
- A Slack App-Level Token that starts with `xapp-`.
- A Slack Bot User OAuth Token that starts with `xoxb-`.
- The target Slack channel where people will mention the app.

### Create the Slack App

1. Open [Slack API Apps](https://api.slack.com/apps).
2. Create a new app from scratch.
3. Choose the workspace where you want to test OpenTag.
4. Keep this app page open. Every Slack value OpenTag asks for comes from this page.

If Slack offers **Create from manifest**, that is the fastest path. Use a manifest with:

- Socket Mode enabled.
- Bot scopes: `app_mentions:read`, `chat:write`.
- Bot event subscription: `app_mention`.

You still need to install the app and create the App-Level Token in the steps below.

### Enable Socket Mode

1. In [Slack API Apps](https://api.slack.com/apps), open your app.
2. Go to **Socket Mode**.
3. Enable Socket Mode.
4. Create an App-Level Token with this scope:
   - `connections:write`
5. Copy the App-Level Token. It starts with `xapp-`.

OpenTag asks for this as:

```text
Slack App-Level Token
```

### Add Bot Permissions

1. In the same Slack app, go to **OAuth & Permissions**.
2. Under **Bot Token Scopes**, add:
   - `app_mentions:read`
   - `chat:write`
3. Install or reinstall the app to your workspace.
4. Copy **Bot User OAuth Token**. It starts with `xoxb-`.

OpenTag asks for this as:

```text
Slack Bot User OAuth Token
```

### Subscribe to App Mentions

1. In the same Slack app, go to **Event Subscriptions**.
2. Enable events.
3. Under **Subscribe to bot events**, add:
   - `app_mention`
4. Save changes.

Do not enter a Request URL for Socket Mode. Slack delivers the event through the WebSocket connection opened by `opentag start`.

## Advanced: Public Events API

Choose this mode when OpenTag has a stable public endpoint, or when you intentionally want to test with a tunnel.

### What You Need

- A Slack app installed in your workspace.
- A public URL that forwards to your local OpenTag Slack ingress.
- A Slack Signing Secret.
- A Slack Bot User OAuth Token.
- The target Slack channel where people will mention the app.

For local testing, expose OpenTag with a tunnel:

```bash
ngrok http 3040
```

Your Slack Request URL should look like:

```text
https://<your-tunnel-host>/slack/events
```

### Configure Events API

1. In [Slack API Apps](https://api.slack.com/apps), open your app.
2. Go to **Basic Information** -> **App Credentials** and copy **Signing Secret**.
3. Go to **OAuth & Permissions** and add the same bot scopes:
   - `app_mentions:read`
   - `chat:write`
4. Install or reinstall the app.
5. Go to **Event Subscriptions**.
6. Enable events.
7. Paste your Request URL:

```text
https://<your-tunnel-host>/slack/events
```

8. Under **Subscribe to bot events**, add:
   - `app_mention`
9. Save changes.

Do not enable Socket Mode for this Events API setup.

## Find Team and Channel IDs

OpenTag asks for:

```text
Slack Team ID
Slack Channel ID
```

You can find them in Slack:

1. Open Slack in the browser.
2. Open the target channel.
3. Copy the channel URL. It usually contains both IDs:

```text
https://app.slack.com/client/T0123456789/C0123456789
```

In that example:

- Team ID: `T0123456789`
- Channel ID: `C0123456789`

Invite the Slack app to the channel before testing. In the target channel, run:

```text
/invite @OpenTag
```

Use your app's actual display name if you renamed it.

## Test

After setup, start OpenTag:

```bash
opentag start
```

Then mention the app in the bound channel:

```text
@OpenTag summarize this thread
```

OpenTag should acknowledge the request and later reply in the same Slack thread.

If the reply includes a pull request action, but your config only contains Slack credentials, OpenTag will continue with a follow-up run instead of creating the GitHub PR directly. Configure GitHub as a repository target before expecting Slack `apply 1` replies to create PRs.
