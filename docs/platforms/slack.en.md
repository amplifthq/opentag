# Slack Setup

Use this guide when `opentag setup` asks for Slack credentials.

## What You Need

- A Slack app installed in your workspace.
- A public URL that forwards to your local OpenTag Slack ingress.
- The target Slack channel where people will mention the app.

For local testing, expose OpenTag with a tunnel:

```bash
ngrok http 3040
```

Your Slack Request URL should look like:

```text
https://<your-tunnel-host>/slack/events
```

## Create the Slack App

1. Open [Slack API Apps](https://api.slack.com/apps).
2. Create a new app from scratch.
3. Choose the workspace where you want to test OpenTag.
4. Go to **Basic Information** and copy **Signing Secret**.

OpenTag asks for this as:

```text
Slack Signing Secret
```

## Add Bot Permissions

1. Go to **OAuth & Permissions**.
2. Under **Bot Token Scopes**, add:
   - `app_mentions:read`
   - `chat:write`
3. Install or reinstall the app to your workspace.
4. Copy **Bot User OAuth Token**. It starts with `xoxb-`.

OpenTag asks for this as:

```text
Slack Bot User OAuth Token
```

## Enable Events

1. Go to **Event Subscriptions**.
2. Enable events.
3. Paste your Request URL:

```text
https://<your-tunnel-host>/slack/events
```

4. Under **Subscribe to bot events**, add:
   - `app_mention`
5. Save changes.

Use the Events API Request URL path exactly as shown above. Do not enable Socket Mode for this local Events API setup.

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

Invite the Slack app to the channel before testing.

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
