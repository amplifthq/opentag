# LINE Messenger Setup

Use this guide when `opentag setup` asks for LINE credentials.

OpenTag uses a text-only LINE Messaging API webhook. LINE sends message events to your local OpenTag process through a public tunnel, then OpenTag runs the selected local coding agent and sends final replies with the LINE push message API.

Media, Flex messages, rich menus, and in-chat `/bind` are not part of this MVP. Bind one LINE user, group, or room during setup.

## Official Links

- [LINE Developers Console](https://developers.line.biz/console/)
- [Receiving messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Sending messages](https://developers.line.biz/en/docs/messaging-api/sending-messages/)

## What You Need

- A LINE Official Account with Messaging API enabled.
- Channel secret.
- Channel access token.
- A public tunnel that forwards to the local LINE listener.
- The LINE conversation ID to bind: use `auto`, or enter `source.userId`, `source.groupId`, or `source.roomId`.

## 1. Find Conversation ID

LINE webhook events include the source ID. Use:

- Direct chat: `source.userId`
- Group chat: `source.groupId`
- Room chat: `source.roomId`

If you do not know it yet, enter `auto` during setup. OpenTag will bind signed LINE users, groups, or rooms that reach the webhook to the selected project.

## 2. Run Setup

```bash
opentag setup --platform line
```

OpenTag asks for:

```text
LINE account ID
LINE channel secret
LINE channel access token
LINE conversation ID
Local LINE webhook port
```

The default local port is `3070`.

## 3. Create A Public Tunnel

Start OpenTag, then expose the LINE listener:

```bash
opentag start
ngrok http 3070
```

The local webhook is:

```text
http://localhost:3070/line/events/<accountId>
```

The LINE console webhook URL should use your tunnel host:

```text
https://<your-tunnel-host>/line/events/<accountId>
```

## 4. Configure LINE Console

1. Open [LINE Developers Console](https://developers.line.biz/console/).
2. Open your Messaging API channel.
3. Copy **Channel secret** into setup.
4. Create or copy a **Channel access token** into setup.
5. Set **Webhook URL** to `https://<your-tunnel-host>/line/events/<accountId>`.
6. Enable **Use webhook**.

LINE signs webhook requests with `x-line-signature`. OpenTag verifies the raw request body before parsing JSON.

Put `auto` or the source ID into `LINE conversation ID` during setup. OpenTag writes a generic channel binding with `provider: "line"` so the local dispatcher can route messages to the selected Project Target.

## 5. Test

Direct messages are treated as commands. In group or room chats, mention the bot or start with `/opentag`:

```text
/opentag investigate this
```

OpenTag replies in the same LINE conversation with plain text.
