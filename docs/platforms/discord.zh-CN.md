# Discord 配置

当 `opentag setup --platform discord` 询问 Discord 参数时，请使用这份指南。

OpenTag 默认通过 Discord Gateway 接收 slash-command interactions。默认模式不需要公网 tunnel：本地 dispatcher 保持 Gateway WebSocket 连接，接收 `INTERACTION_CREATE`，通过 Discord HTTP callback API 快速 ack，然后创建本地 run，并把 progress/final message 发回原频道。

如果你希望 Discord 主动把 interactions 推送到公网 HTTPS endpoint，也可以使用高级 Interactions Endpoint webhook 模式。

## 需要准备

- [Discord Developer Portal](https://discord.com/developers/applications) 中的一个 application。
- **Bot** 页面里的 bot token，用于 Gateway 连接和频道消息。
- 一个已注册的 `/opentag` slash command。
- 仅高级 webhook 模式需要：application public key 和公网 HTTPS tunnel。

## 创建或打开 Discord Application

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)。
2. 创建 application，或打开已有 application。
3. 在 **Bot** 页面创建或重置 bot token，并复制 token。
4. 只有高级 webhook 模式需要在 **General Information** 页面复制 **Public Key**。

请妥善保管 bot token。OpenTag 会把它存在本地 config 中，并在 `opentag status` / `opentag doctor` 中脱敏。

## 运行 OpenTag Setup

默认 Gateway 模式：

```bash
opentag setup \
  --platform discord \
  --discord-bot-token <bot-token>
```

setup 会保存：

- `platforms.discord.mode` 为 `gateway`
- `platforms.discord.botToken`

## 注册 Slash Command

注册一个名为 `opentag` 的 global 或 guild command。测试时推荐 guild command，因为更新更快。

OpenTag 的 Discord adapter 接收 `/opentag <prompt>`，并把它路由到和其他平台一样的 run lifecycle。命令注册 endpoint 和 bot-token 鉴权请参考 Discord [Application Commands](https://docs.discord.com/developers/interactions/application-commands) 文档。

启动 OpenTag：

```bash
opentag start
```

OpenTag 会打印：

```text
Discord: using Gateway connection
Discord tunnel: not required in Gateway mode
```

官方参考：

- [Interactions Overview](https://docs.discord.com/developers/interactions/overview)
- [Gateway `INTERACTION_CREATE`](https://docs.discord.com/developers/events/gateway-events#interaction-create)
- [Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)

## 高级 Webhook 模式

只有当你希望 Discord 把 interactions 推送到公网 HTTPS URL 时，才需要 webhook 模式：

```bash
opentag setup \
  --platform discord \
  --discord-mode webhook \
  --discord-public-key <application-public-key> \
  --discord-bot-token <bot-token>
```

如果需要非默认 endpoint path，可以加 `--discord-webhook-path /your/path`。

启动 OpenTag，并把 tunnel 指向 dispatcher：

```bash
ngrok http 3030
opentag start
```

OpenTag 会打印：

```text
Discord local interactions endpoint: http://127.0.0.1:3030/discord/interactions
Discord Interactions Endpoint URL: https://<your-tunnel-host>/discord/interactions
```

在 Developer Portal 打开 **General Information**，把公网 HTTPS URL 填到 **Interactions Endpoint URL**。

Discord 会通过 PING interaction 验证 URL。OpenTag 会返回 PONG，并使用配置的 public key 校验 `X-Signature-Ed25519` 和 `X-Signature-Timestamp`。

官方参考：

- [Configuring an Interactions Endpoint URL](https://docs.discord.com/developers/interactions/overview#configuring-an-interactions-endpoint-url)
- [Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)

## 绑定和测试

Discord channel binding 使用：

```text
provider: discord
accountId: <application_id>
conversationId: <channel_id>
```

如果 channel 还没绑定，OpenTag 会 ack command，但不能启动 run。请通过 dispatcher API 或本地 config 绑定 channel，然后运行：

```text
/opentag investigate this failing test
```

预期行为：

- Discord 通过 Gateway 模式或 webhook 模式发送 slash command。
- OpenTag 快速 ack。
- 本地 runner 针对已绑定 checkout 启动。
- OpenTag 在同一个 Discord channel 发送或编辑 status/final message。

## 当前范围

已支持：

- `opentag setup --platform discord` CLI setup。
- 默认 Gateway `INTERACTION_CREATE` 处理，不需要公网 tunnel。
- 高级本地 dispatcher Interactions Endpoint：`/discord/interactions`。
- Slash-command interaction handling。
- Webhook 模式使用 Discord application public key 做签名校验。
- Bot-token channel replies 和 status-message edit chain。
- 有组件回调时，把 typed source-thread actions 路由到 Discord component callbacks。

暂未实现：

- 自动注册 slash command。
- Gateway `@mention` 支持。
- Discord 内 source-thread `/bind` 自服务。
- Discord hosted relay mode。
