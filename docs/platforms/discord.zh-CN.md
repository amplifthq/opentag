# Discord 配置

当 `opentag setup --platform discord` 询问 Discord 相关信息时，请参考本指南。

## 你需要准备

- 一个带机器人（Bot）的 Discord 应用，在[开发者后台](https://discord.com/developers/applications)创建。
- 应用「General Information（基本信息）」页的 **Application ID** 和 **Public Key**。
- 应用「Bot（机器人）」页的 **Bot Token**（点 Reset Token 后仅显示一次）。
- 要绑定的**频道 ID**（在 Discord 设置里开启开发者模式，右键频道 → 复制频道 ID）。
- 一个公网 tunnel，把 Discord 交互请求转发到本机 OpenTag dispatcher（默认端口 3030）。

## 创建应用和机器人

1. 打开[开发者后台](https://discord.com/developers/applications)创建应用。
2. 在 **Bot** 页点 **Reset Token（重置令牌）**，复制 bot token。
3. 在 **Bot** 页确认 **Requires OAuth2 Code Grant（需要 OAuth2 代码授权）** 处于**关闭**状态（否则简单邀请链接会报 "Integration requires code grant"）。
4. 用最小权限把机器人邀请进服务器：

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=84992
```

`permissions=84992` 对应查看频道、发送消息、读取消息历史、嵌入链接。

请妥善保管 bot token。OpenTag 将其保存在本地配置文件中，并在 `opentag status` 和 `opentag doctor` 中脱敏展示。

## 运行 OpenTag Setup

```bash
opentag setup \
  --platform discord \
  --discord-application-id <APPLICATION_ID> \
  --discord-channel-id <CHANNEL_ID>
```

setup 会提示输入公钥和 bot token，并保存：

- `platforms.discord.applicationId`
- `platforms.discord.publicKey`
- `platforms.discord.botToken`
- `platforms.discord.channelId`
- `platforms.discord.webhookPath`（默认 `/discord/interactions`）

同时会把该 Discord 频道绑定到本地项目，使该频道内的 `/opentag` 调用路由到本地 runner。

## 注册斜杠命令

Discord 斜杠命令需要为应用注册一次。Guild（服务器）级命令即刻生效：

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

服务器 ID 可在开发者模式下右键服务器名复制，或用 bot token 调 `GET /users/@me/guilds` 查询。

## 配置 Interactions Endpoint

Discord 通过公网 HTTPS webhook 投递交互请求。端点挂载在本地 dispatcher 上，因此 tunnel 指向 3030 端口：

1. 先启动 OpenTag，让端点能应答 Discord 的验证 PING：

```bash
opentag start
```

2. 起 tunnel 指向 dispatcher：

```bash
cloudflared tunnel --url http://localhost:3030
```

3. 在开发者后台 → General Information（基本信息）里，把 **Interactions Endpoint URL** 设为：

```text
https://<你的-tunnel-域名>/discord/interactions
```

保存时 Discord 会发送带签名的 PING 验证，OpenTag 自动应答。若验证失败，检查 `opentag start` 是否在运行、公钥是否与应用一致。

快速 tunnel 每次重启都会更换 URL——重启 tunnel 后需要回来更新 Interactions Endpoint URL。

## 测试

在绑定的频道里执行：

```text
/opentag prompt: say hi executor: echo
```

OpenTag 会在频道内受理、在本地 runner 上执行，并把结果编辑进状态消息。把 `executor` 换成 `codex` 或 `claude-code`（或不填，使用仓库默认执行器）即可跑真实编码任务。机器人显示离线是正常现象——interactions webhook 不需要 gateway 长连接。

## 常见问题

- **"This interaction failed"**：tunnel 掉了、tunnel URL 变了，或 `opentag start` 没在运行。
- **Interactions Endpoint URL 保存失败**：tunnel 打不通 OpenTag，或 `platforms.discord.publicKey` 与应用不匹配。
- **打不出 `/opentag`**：斜杠命令没有为该服务器注册，或邀请机器人时缺少 `applications.commands` scope。
- **只收到受理、没有后续**：bot token 缺失或错误（`opentag doctor` 可查看密钥就绪状态），或频道未绑定。
