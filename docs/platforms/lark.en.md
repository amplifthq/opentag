# Lark / Feishu Setup

Use this guide when `opentag setup` asks how OpenTag should connect to Lark / Feishu.

## Recommended Path: QR Scan

The easiest setup path is:

```text
Create a new Personal Agent
```

OpenTag shows a QR code. Scan it with Lark or Feishu, finish creating the Personal Agent app, and keep the terminal open. OpenTag continues automatically after the app is created.

Use this path unless you already manage a self-built Lark / Feishu app.

## Saved Personal Agent

If OpenTag has already saved a Personal Agent on this machine, setup shows:

```text
Use saved Personal Agent
```

The CLI also shows safe details such as domain, App ID prefix, Bot Open ID prefix, and where the saved config came from. Secrets are not printed.

Choose this when you want to reuse the existing app.

## Manual Credentials

Choose manual setup only when you already have a self-built app.

OpenTag asks for:

```text
Lark App ID
Lark App Secret
Lark Bot Open ID (optional)
```

You can find App ID and App Secret in the Lark / Feishu developer console for your app.

The app must support bot messages and long-connection events. If you are not sure, use the QR scan path instead.

## Domain

OpenTag asks which domain to use:

- `Lark` for larksuite.com tenants
- `Feishu` for feishu.cn tenants

Pick the one that matches the app you created.

## Test

After setup, start OpenTag:

```bash
opentag start
```

Then mention or message the Personal Agent from Lark / Feishu. OpenTag should receive the message, run the selected coding agent locally, and reply in the same conversation.
