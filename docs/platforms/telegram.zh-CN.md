# Telegram 配置

当 `opentag setup --platform telegram` 询问 Telegram 参数时，请使用这份指南。

OpenTag 默认通过 `getUpdates` polling 在本地接收 Telegram bot 消息。默认模式不需要公网 tunnel：本地 dispatcher 持续轮询 Telegram，创建本地 run，并把简洁回复发回原 Telegram chat。

如果你希望 Telegram 主动把 update 推送到公网 HTTPS endpoint，也可以使用高级 webhook 模式。

## 需要准备

- 从 [BotFather](https://t.me/BotFather) 获取的 Telegram bot token。
- 可选：bot username，用于群聊里的 `@opentag_bot` 或 `/opentag@opentag_bot`。
- 可选：允许在群聊里执行 `/bind` 和 `/unbind` 的 Telegram user id 列表。
- 仅高级 webhook 模式需要：一个指向本机 OpenTag dispatcher 的公网 HTTPS tunnel。

## 创建 Bot

1. 打开 [BotFather](https://t.me/BotFather)。
2. 使用 `/newbot`，或打开已有 bot。
3. 复制 bot token，格式类似：

```text
123456789:AA...
```

数字前缀就是 bot id。OpenTag 会自动从 token 推导 bot id，除非你显式传 `--telegram-bot-id`。

建议在 BotFather 中配置 bot commands：

```text
opentag - 启动 OpenTag run 或 source-thread control
help - 显示 OpenTag 命令
status - 显示绑定的 Project Target 和 active run
doctor - 显示脱敏 readiness
stop - 请求取消
bind - 绑定这个 chat 到 Project Target
unbind - 移除这个 chat binding
```

## 运行 OpenTag Setup

默认 polling 模式：

```bash
opentag setup \
  --platform telegram \
  --telegram-bot-token 123456789:replace-me
```

如果用于群聊，请指定允许改绑定的 Telegram user id：

```bash
opentag setup \
  --platform telegram \
  --telegram-bot-token 123456789:replace-me \
  --telegram-bot-username opentag_bot \
  --telegram-binding-admin-user-ids 111111,222222
```

setup 会保存：

- `platforms.telegram.mode` 为 `polling`
- `platforms.telegram.botId`
- `platforms.telegram.agentId`
- `platforms.telegram.botUsername`
- `platforms.telegram.botToken`
- `platforms.telegram.bindingAdminUserIds`

OpenTag 会把 token 存在本地 config 里，并在 `opentag status` / `opentag doctor` 中脱敏。

## 启动 Polling

启动 OpenTag：

```bash
opentag start
```

OpenTag 会打印：

```text
Telegram: using getUpdates polling
Telegram tunnel: not required in polling mode
```

Polling 模式启动时会先调用一次 Telegram `deleteWebhook`，因为 Telegram 不允许 bot 在 webhook 已配置时使用 `getUpdates`。之后 OpenTag 会通过 `getUpdates` 长轮询接收 update。

官方参考：[Telegram Bot API `getUpdates`](https://core.telegram.org/bots/api#getupdates)。

## 高级 Webhook 模式

只有当你希望 Telegram 把 update 推送到公网 HTTPS URL 时，才需要 webhook 模式：

```bash
opentag setup \
  --platform telegram \
  --telegram-mode webhook \
  --telegram-bot-token 123456789:replace-me
```

启动 OpenTag，并把 tunnel 指向 dispatcher：

```bash
ngrok http 3030
opentag start
```

OpenTag 会打印：

```text
Telegram local webhook: http://127.0.0.1:3030/telegram/events/<bot_id>
Telegram webhook URL: https://<your-tunnel-host>/telegram/events/<bot_id>
```

用公网 HTTPS URL 和 setup 输出的 secret token 设置 Telegram webhook：

```bash
curl "https://api.telegram.org/bot<bot-token>/setWebhook" \
  --get \
  --data-urlencode "url=https://<your-tunnel-host>/telegram/events/<bot_id>" \
  --data-urlencode "secret_token=<opentag-secret-token>"
```

Telegram 会把 secret token 放在 `X-Telegram-Bot-Api-Secret-Token` 请求头里发给 OpenTag。OpenTag 会先校验这个头，再接受 webhook update。

官方参考：[Telegram Bot API `setWebhook`](https://core.telegram.org/bots/api#setwebhook)。

## 绑定和测试

在 bot 私聊里：

```text
/bind github:acme/demo
fix this failing test
```

在群聊里，需要先 address bot：

```text
@opentag_bot /bind github:acme/demo
@opentag_bot investigate this bug
```

预期行为：

- `/bind` 把 Telegram chat 连接到一个 Project Target。
- 任务消息创建 OpenTag run。
- OpenTag 在同一个 Telegram chat 回复。
- `/status`、`/doctor` 和 `/stop [run_id]` 是 source-thread controls，不会创建新的 run。

## 当前范围

已支持：

- `opentag setup --platform telegram` CLI setup。
- 默认本地 `getUpdates` polling，不需要公网 tunnel。
- 高级本地 dispatcher webhook：`/telegram/events/<bot_id>`。
- Bot token 回调和自服务回复。
- 私聊 `/bind`。
- 配置 `--telegram-binding-admin-user-ids` 后的群聊 `/bind`。
- Source-thread controls：`/help`、`/bind`、`/unbind confirm`、`/status`、`/doctor`、`/stop [run_id]`。

暂未实现：

- 自动调用 `setWebhook`。
- Telegram inline button action receipts。
- Telegram hosted relay mode。
