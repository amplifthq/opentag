# Microsoft Teams 配置

当 `opentag setup --platform teams` 询问 Microsoft Teams 参数时，请使用这份指南。

OpenTag 通过 Bot Framework webhook 接收 Microsoft Teams 消息。Teams 只支持通过 HTTPS 推送 activity，所以这个平台始终需要一个指向本地 dispatcher 的公网 HTTPS Messaging endpoint（不像 Discord 默认的 Gateway 模式，也不像 Telegram 默认的 polling 模式）。

## 需要准备

- [Azure Portal](https://portal.azure.com) 中的一个 Azure Bot 资源（Bot Framework 注册）。开发和测试使用 **F0（免费）** 定价层就足够。
- Bot 的 **Microsoft App ID**，以及一个 **client secret**（也就是 OpenTag 需要的 `appPassword`）。
- 可选的 **Tenant ID**，用于把 bot 限定在单个 Microsoft 365 租户内。
- 一个 dev tunnel（`devtunnel` 或 `ngrok`），在开发阶段把本地 dispatcher 的 webhook endpoint 暴露到公网。
- 把 bot 安装进一个 **team**，并添加到目标 **channel**。

## 创建 Azure Bot 资源

1. 打开 [Azure Portal](https://portal.azure.com)，创建一个新的 **Azure Bot** 资源。
2. 开发阶段选择 **F0** 免费定价层即可（只有在需要生产级消息量时才升级到 **S1**）。
3. 创建过程中，可以新建 Microsoft App ID，也可以使用已有的 Microsoft Entra ID 应用注册。
4. 创建完成后，打开 Bot 资源的 **Configuration** 页面，复制 **Microsoft App ID**。
5. 在同一个页面（或者应用注册的 **Certificates & secrets** 页面）创建一个新的 **client secret**。请立即复制密码值——Azure 只会显示一次。这就是 OpenTag 保存的 `appPassword`。

请妥善保管 client secret。OpenTag 会把它存在本地 config 中，并在 `opentag status` / `opentag doctor` 中脱敏。

完整流程请参考微软官方的 [Bot Framework 注册快速入门](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration)。

## 单租户 vs 多租户

- **多租户**应用（默认）可以安装到任意 Microsoft 365 租户。不需要设置 `tenantId`。
- **单租户**应用只能在一个 Microsoft Entra ID 租户内使用。如果你的应用注册是单租户，请设置 `tenantId`，这样 OpenTag 才能用正确的 issuer 校验入站 Bot Framework JWT。

Tenant ID 可以在 Microsoft Entra ID 应用注册的 **Overview** 页面找到。

## 暴露本地 Dispatcher

Teams 需要一个公网 HTTPS URL 作为 bot 的 messaging endpoint。启动一个指向本地 dispatcher 端口（默认 `3030`）的 dev tunnel：

```bash
devtunnel host -p 3030
# 或者
ngrok http 3030
```

在 Azure Bot 资源的 **Configuration** 页面，把 **Messaging endpoint** 设置为：

```text
https://<tunnel-host>/teams/messages
```

如果需要非默认 endpoint path，在 setup 时加上 `--teams-webhook-path /your/path`，并在配置 Messaging endpoint 时使用对应的 URL。

## 把 Bot 安装进 Team

1. 在 Azure Bot 资源的 **Channels** 页面添加 **Microsoft Teams** channel。
2. 打包并侧载（或者通过组织的应用目录发布）引用你 Microsoft App ID 的 Teams app manifest，然后把这个应用添加进目标 **team**。
3. 把 bot 添加到你希望 OpenTag 监听的具体 **channel**。

组织租户通常会限制自定义应用的安装。如果侧载被禁用，请联系 Teams 管理员批准该应用，或者为你的租户开启自定义应用上传。

## 运行 OpenTag Setup

```bash
opentag setup \
  --platform teams \
  --teams-app-id <microsoft-app-id> \
  --teams-app-password <client-secret> \
  --teams-tenant-id <tenant-id>
```

多租户应用可以省略 `--teams-tenant-id`。

setup 会保存：

- `platforms.teams.appId`
- `platforms.teams.appPassword`
- `platforms.teams.tenantId`（只有提供时才保存）
- `platforms.teams.webhookPath`（默认 `/teams/messages`）

启动 OpenTag：

```bash
opentag start
```

OpenTag 会打印：

```text
Teams local webhook: http://127.0.0.1:3030/teams/messages
Teams Messaging Endpoint URL: https://<your-tunnel-host>/teams/messages
```

## 绑定和测试

Teams channel binding 使用 `(tenantId, conversationId)` 作为 key，而不是只用 `channelId`——team 的默认 **General** channel 可能没有 `channelId`，所以 `conversationId` 才是可靠的 key：

```text
provider: teams
tenantId: <tenant_id>
conversationId: <conversation_id>
```

如果 channel 还没绑定，OpenTag 会 ack 收到的 activity，但不能启动 run。请通过 dispatcher API 或本地 config 绑定 channel，然后在目标 channel 里发送：

```text
@OpenTag investigate this failing test
```

预期行为：

- Teams 通过 dev tunnel 把 activity 推送到你的 Messaging endpoint。
- OpenTag 在处理前会校验入站 Bot Framework JWT（JWKS、audience 和 `serviceUrl` claim）。
- 本地 runner 针对已绑定 checkout 启动。
- OpenTag 在同一个 Teams channel 以纯文本消息回复。

如果要执行建议的 action，在 mention 时加上 action 编号：

```text
@OpenTag apply 1
```

官方参考：

- [Bot Framework 注册快速入门](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration)
- [为 Microsoft Teams 创建 bot](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams)
- [发送 proactive 消息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rest-api/send-proactive-messages)

## 当前范围（v1）

已支持：

- `opentag setup --platform teams` CLI setup。
- `/teams/messages` 上的 Bot Framework webhook ingest，包含入站 JWT 校验（JWKS、audience 和 `serviceUrl` claim）。
- **channel** 会话中的 `@OpenTag` mention 处理。
- `@OpenTag apply N` action 路由。
- 纯文本 channel 回复。

暂未实现 / v1 范围之外：

- Adaptive Cards 或可点击的 Apply 按钮。
- 私聊（personal chat）和群聊（group chat），当前只支持 channel。
- 独立的 Teams events service——webhook 运行在本地 dispatcher 内部。
