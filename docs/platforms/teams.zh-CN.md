# Microsoft Teams 配置

当 `opentag setup --platform teams` 询问 Microsoft Teams 参数时，请使用这份指南。

OpenTag 通过 Bot Framework webhook 接收 Microsoft Teams channel 消息。Teams 只通过 HTTPS 投递 activity，所以这个平台始终需要一个指向本地 dispatcher 的公网 HTTPS Messaging endpoint（不像 Discord 默认的 Gateway 模式，也不像 Telegram 默认的 polling 模式）。

## 端到端配置清单

阅读详细步骤前，可以先按这个清单确认整体路线：

1. 确认你能登录一个启用了 Teams 的 Microsoft 365 租户。
2. 确认你可以上传/安装自定义 Teams app，或者有 Teams 管理员能帮你安装。
3. 创建 Azure Bot 资源，并复制 Microsoft App ID。
4. 从 Microsoft Entra ID 复制 app/Tenant ID。
5. 创建 Azure Bot client secret，并安全保存 secret **Value**。
6. 在 Azure Bot 资源中添加 Microsoft Teams channel。
7. 启动指向本地 `3030` 端口的公网 HTTPS tunnel（调试时 `ngrok` 最容易 inspect；`devtunnel` 必须加 `--allow-anonymous`）。
8. 把 Azure Bot Messaging endpoint 设置为 `https://<tunnel-host>/teams/messages`。
9. 创建或下载引用 Microsoft App ID 的 Teams app package，并安装到目标 team/channel。
10. 运行 `opentag setup --platform teams`，在本地输入 Teams 凭据。
11. 把 Teams channel（`tenantId` + 基础 `conversationId`）绑定到目标 repository。
12. 发送 `@OpenTag investigate ...` 测试只读链路。
13. 发送 `@OpenTag fix ...` 测试有写权限的 Claude/Codex run。
14. 可选：配置 GitHub/GitLab repo binding 和 apply token，然后测试 `@OpenTag apply 1`。

## 需要准备

- 一个启用了 Microsoft Teams 的 Microsoft 365 租户。你**不需要**是 Microsoft 365 Developer Program 成员，但只有个人 Gmail/Outlook Microsoft account 不够。
- 能在目标 team 里安装或上传自定义 Teams app 的权限，或者有 Teams 管理员帮你批准/安装。
- 一个能创建 **Azure Bot** 资源的 Azure subscription。开发和 smoke test 使用 **F0（免费）** 定价层即可。
- Bot 的 **Microsoft App ID**、bot/app 所在 **Tenant ID**，以及一个 **client secret value**（也就是 OpenTag 需要的 `appPassword`）。
- 一个公网 HTTPS tunnel（`ngrok` 或 `devtunnel`），用于在开发时暴露本地 dispatcher webhook endpoint。
- 把 bot 安装进一个 **team**，并添加到目标 **channel**。

请妥善保管所有 secret。不要把 client secret、bot token、GitHub token 或一次性验证码贴到聊天、issue 或文档里。

## 创建 Azure Bot 资源

1. 打开 [Azure Portal](https://portal.azure.com)，创建一个新的 **Azure Bot** 资源。
2. 开发阶段选择 **F0** 免费定价层即可（只有生产级消息量才需要升级到 **S1**）。
3. 新 bot 建议使用你 Microsoft 365 租户里的 **single-tenant** app。
4. 创建完成后，打开 Bot 资源的 **Configuration** 页面，复制 **Microsoft App ID**。
5. 在 Microsoft Entra ID 应用注册的 **Overview** 页面复制 **Tenant ID**。
6. 在 **Certificates & secrets** 页面创建新的 **client secret**。请立即复制 secret 的 **Value**——Azure 只显示一次。这个 Value 就是 OpenTag 保存的 `appPassword`。
7. 在 Azure Bot 资源的 **Channels** 页面添加 **Microsoft Teams** channel。

完整流程可参考微软官方的 [Bot Framework 注册快速入门](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) 和 [Teams bot 创建指南](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams)。

## 暴露本地 Dispatcher

Teams 需要一个公网 HTTPS URL 作为 bot 的 Messaging endpoint。启动一个指向本地 dispatcher 端口（默认 `3030`）的 tunnel。

调试时推荐使用：

```bash
ngrok http 3030
```

`ngrok` 会打印类似这样的转发地址：

```text
https://example.ngrok-free.dev -> http://localhost:3030
```

它还提供本地 inspect 页面：

```text
http://127.0.0.1:4040
```

可以用这个页面确认 Teams 是否发来了 `POST /teams/messages`，也可以查看非敏感 Activity 字段，例如 `conversation.id`、`channelData.channel.id` 和 `channelData.tenant.id`。

如果使用 `devtunnel`，必须允许匿名访问：

```bash
devtunnel host -p 3030 --allow-anonymous
```

如果不加 `--allow-anonymous`，tunnel URL 可能会跳转到 Microsoft 登录页。Bot Framework 无法完成这种交互式登录，因此 Teams 消息无法到达 OpenTag。

验证公网 tunnel 是否能访问 OpenTag：

```bash
curl https://<tunnel-host>/healthz
```

预期返回：

```json
{"ok":true}
```

在 Azure Bot 资源的 **Configuration** 页面，把 **Messaging endpoint** 设置为：

```text
https://<tunnel-host>/teams/messages
```

如果你通过 `--teams-webhook-path /your/path` 配置了非默认路径，Azure 里也要使用匹配的 URL。

## 把 Bot 安装进 Team

Teams 需要一个引用 Azure Bot Microsoft App ID 的 app package。

最简单的方式是使用 [Teams Developer Portal](https://dev.teams.microsoft.com)：

1. 创建一个新 app。
2. 添加 bot，或选择已有 bot。
3. 填入 Azure Bot 的 **Microsoft App ID**。
4. scope 选择 **Team**。OpenTag v1 支持 team/channel 会话；personal chat 和 group chat 暂不支持。
5. 下载 app package。
6. 在 Teams 里上传 custom app，并添加到目标 team/channel。

Teams app package 是一个 `.zip`，至少包含：

```text
manifest.json
color.png
outline.png
```

组织租户通常会限制自定义 app 安装。如果上传被禁用，请联系 Teams 管理员批准该 app，或者为你的租户开启 custom app upload。

## 运行 OpenTag Setup

交互式 setup 对 secret 更安全，因为不会把 client secret 写进 shell history：

```bash
opentag setup --platform teams
```

按提示填写：

```text
Microsoft App ID: <microsoft-app-id>
App password: <client-secret-value>
Tenant ID: <tenant-id>          # single-tenant app 推荐填写
Webhook path: /teams/messages   # 默认值
```

如果需要脚本化 setup，可以使用：

```bash
opentag setup \
  --platform teams \
  --teams-app-id <microsoft-app-id> \
  --teams-app-password <client-secret-value> \
  --teams-tenant-id <tenant-id> \
  --teams-webhook-path /teams/messages
```

setup 会保存：

- `platforms.teams.appId`
- `platforms.teams.appPassword`
- `platforms.teams.tenantId`（提供时保存）
- `platforms.teams.webhookPath`（默认 `/teams/messages`）

启动 OpenTag：

```bash
opentag start
# 或后台服务：
opentag service start
```

OpenTag 会打印本地 Teams webhook，并提醒你在 Azure 中配置公网 tunnel host。

### Service 模式下的 Claude Code

如果 `opentag service` 由 macOS LaunchAgent 运行，它的 `PATH` 可能不包含交互式 shell 里的 `~/.local/bin`。如果 run 失败并显示：

如果 Claude executor 未就绪，请先完成本机 Claude 登录，然后重启服务。
Claude ACP adapter 已随 OpenTag 提供，不再需要配置 CLI 路径：

```bash
opentag service restart
```

## 绑定 Teams Channel

Teams channel binding 使用 `(tenantId, conversationId)` 作为 key。

真实 Teams channel 消息里经常能看到两种 id：

```text
channelData.channel.id: 19:...@thread.tacv2
conversation.id:        19:...@thread.tacv2;messageid=<root-message-id>
```

推荐绑定 `channelData.channel.id` 或 `channelData.teamsChannelId` 里的基础 channel id：

```text
provider: teams
accountId / tenantId: <tenant-id>
conversationId: 19:...@thread.tacv2
```

OpenTag 也能处理包含 `;messageid=...` 的完整 thread conversation id，用于回复和 thread action。回复会使用 Teams 的完整 conversation id，以确保落在同一个 thread。

如果 channel 还没配置，OpenTag 会 ack 收到的 activity，但不能启动 run。请通过 dispatcher API 或本地 config 创建 Teams channel binding。通用 ACP 工作可以不带 repository target；只有基于仓库的编码或 pull request 任务才要求配置 repository。

## 触发 Run

setup 和绑定完成后，在目标 channel 里 mention bot：

```text
@OpenTag investigate this failing test
```

`investigate`、`review`、`explain` 适合只读任务。如果希望修改仓库，请以 `fix` 或 `run` 开头，这样 OpenTag 才会给本地 executor `repo:write` 权限：

```text
@OpenTag fix README.md by adding one sentence saying "Test from Teams."
```

如果没有 `fix` 或 `run`，Claude Code 可能会以 plan mode 运行，只返回计划而不改文件。

预期行为：

- Teams 通过 tunnel 把 Activity 发送到你的 Messaging endpoint。
- OpenTag 在处理前校验入站 Bot Framework JWT 的签名、issuer、audience、必需的 `serviceUrl` claim，以及签名 key 的 `msteams` endorsement。签名保护的 `serviceUrl` 必须与 Activity body 完全一致，避免把 bot Connector token 发往 body 控制的地址。
- 本地 runner 会在已配置的 repository checkout 中启动；无仓库任务则使用隔离的 scratch workspace。
- OpenTag 在同一个 Teams channel/thread 中以纯文本回复。

## Apply Action 和创建 Pull Request

Teams thread 中支持 `@OpenTag apply 1`，但创建 pull request 需要 GitHub 或 GitLab repository target 和 apply credentials。在记录 apply/reject 决定或执行 adapter mutation 之前，OpenTag 会使用 proposal 中保存的 Teams tenant/channel 重新检查当前 channel binding；对于 repository action，还会要求它仍然指向同一个 repository。如果 channel 已移除或重绑，历史 thread action 会 fail closed。

如果要使用 GitHub pull request apply，请把 repository 配置成 GitHub，而不是只配置成本地 repo：

```json
{
  "provider": "github",
  "owner": "<github-owner>",
  "repo": "<github-repo>",
  "checkoutPath": "/path/to/local/checkout",
  "defaultExecutor": "claude-code",
  "baseBranch": "main",
  "pushRemote": "origin"
}
```

同时配置 GitHub token/apply token 并启用 branch preparation：

```json
{
  "daemon": {
    "githubToken": "<redacted>",
    "githubApplyToken": "<redacted>",
    "preparePullRequestBranch": true
  }
}
```

然后把 Teams channel 绑定到这个 GitHub repo：

```text
provider: teams
accountId: <tenant-id>
conversationId: <teams-channel-conversation-id>
repoProvider: github
owner: <github-owner>
repo: <github-repo>
```

成功的写入 run 会显示 **Ready to apply**。确认 receipt 后，在同一个 Teams thread 里批准：

```text
@OpenTag apply 1
```

如果 receipt 显示 direct apply 未配置，请检查 channel binding 是否指向 GitHub/GitLab repo，以及 apply credentials 是否已经配置。

## 故障排查

| 现象 | 常见原因 | 处理方式 |
| --- | --- | --- |
| OpenTag 没收到请求 | Azure Messaging endpoint 错误、Teams app 未安装、或没有真正 mention bot | 检查 endpoint URL、安装 app、并用 bot 名称 mention |
| tunnel URL 跳登录页 | `devtunnel` 没有允许匿名访问 | 用 `devtunnel host -p 3030 --allow-anonymous` 重启 |
| 公网 tunnel 可访问但 Teams 返回 401 | App ID / tenant / secret 不匹配，或 Teams adapter build 太旧 | 确认 Azure Bot App ID 等于 `platforms.teams.appId`，然后重启 OpenTag |
| Claude executor 未就绪 | 本机 Claude 认证缺失或失效 | 完成本机 Claude 登录，重启 OpenTag，再运行 `opentag doctor` |
| Claude 只返回计划 | 命令没有请求写权限 | 使用 `@OpenTag fix ...` 或 `@OpenTag run ...` |
| receipt 显示 direct apply 未配置 | repo binding 只是 local，或缺少 apply token | 绑定到 GitHub/GitLab repo 并配置 apply credentials |
| `apply 1` 找不到 action | 命令没有发在同一个 Teams thread，或服务版本太旧 | 在同一个 thread 回复，并更新到能把 Teams action 映射到 root message id 的版本 |

## 官方参考

- [Bot Framework 注册快速入门](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration)
- [为 Microsoft Teams 创建 bot](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams)
- [在 Teams 中上传自定义 app](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload)
- [发送 proactive 消息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rest-api/send-proactive-messages)

## 当前范围（v1）

已支持：

- `opentag setup --platform teams` CLI setup。
- `/teams/messages` 上的 Bot Framework webhook ingest，包含 fail-closed JWT 校验（JWKS 签名、issuer、audience、必需且匹配的 `serviceUrl`，以及 `msteams` key endorsement）。
- **channel** 会话中的 `@OpenTag` mention 处理。
- Teams thread 中的 `@OpenTag apply N` action 路由。
- 纯文本 channel 回复。

暂未实现 / v1 范围之外：

- Adaptive Cards 或可点击的 Apply 按钮。
- 私聊（personal chat）和群聊（group chat），当前只支持 channel。
- Teams hosted/custom relay ingress——webhook 目前只运行在本地 dispatcher 内部。
- 独立的 Teams events service。
