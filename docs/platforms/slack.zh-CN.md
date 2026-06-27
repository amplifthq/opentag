# Slack 配置教程

当 `opentag setup` 询问 Slack 配置时，用这份教程对照填写。

OpenTag 支持两种 Slack 连接方式：

- **本地 Socket Mode**：推荐在这台电脑上运行 OpenTag 时使用，不需要公网 URL。
- **公网 Events API**：适合云端部署，或者高级用户用 tunnel 做本地测试。

两种方式最终都支持同一个核心体验：在 Slack 里 mention 这个 app，OpenTag 在本机运行 coding agent，然后回到同一个 Slack thread 里回复结果。

Slack-only setup 证明的是 Slack 这条链路。它不会自动获得 GitHub 写权限。如果某次 run 产出了 pull request action，只有在 OpenTag 同时配置了 GitHub repository target 和 GitHub token 时，Slack thread 里的 `apply 1` 才能直接创建 GitHub PR。

## 官方入口

- [Slack App 管理页](https://api.slack.com/apps)
- [Slack App Quickstart](https://docs.slack.dev/quickstart/)
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack OAuth scopes](https://api.slack.com/scopes)

## 推荐：本地 Socket Mode

如果你想让这台电脑上的 `opentag start` 直接接收 Slack mention，选这个模式。

### 你需要准备什么

- 一个安装到 Slack workspace 的 Slack App。
- 这个 app 已开启 Socket Mode。
- 一个以 `xapp-` 开头的 Slack App-Level Token。
- 一个以 `xoxb-` 开头的 Slack Bot User OAuth Token。
- 一个用于测试的 Slack channel。

### 创建 Slack App

1. 打开 [Slack API Apps](https://api.slack.com/apps)。
2. 创建一个新的 app，选择 **From scratch**。
3. 选择要测试的 workspace。
4. 保持这个 app 页面打开。OpenTag 后面问到的 Slack 值都从这个页面拿。

### 开启 Socket Mode

1. 在 [Slack API Apps](https://api.slack.com/apps) 里打开你的 app。
2. 进入 **Socket Mode**。
3. 打开 Socket Mode。
4. 创建一个 App-Level Token，添加这个 scope：
   - `connections:write`
5. 复制 App-Level Token。它一般以 `xapp-` 开头。

OpenTag 里对应这个字段：

```text
Slack App-Level Token
```

### 添加 Bot 权限

1. 在同一个 Slack app 里进入 **OAuth & Permissions**。
2. 在 **Bot Token Scopes** 里添加：
   - `app_mentions:read`
   - `chat:write`
3. 安装或重新安装 app 到 workspace。
4. 复制 **Bot User OAuth Token**。它一般以 `xoxb-` 开头。

OpenTag 里对应这个字段：

```text
Slack Bot User OAuth Token
```

### 订阅 App Mention 事件

1. 在同一个 Slack app 里进入 **Event Subscriptions**。
2. 打开事件订阅。
3. 在 **Subscribe to bot events** 里添加：
   - `app_mention`
4. 保存设置。

Socket Mode 不需要填写 Request URL。`opentag start` 会主动连到 Slack WebSocket，Slack 会通过这条连接把事件推回来。

## 高级：公网 Events API

如果 OpenTag 有一个稳定的公网 endpoint，或者你明确要用 tunnel 做本地测试，选这个模式。

### 你需要准备什么

- 一个安装到 Slack workspace 的 Slack App。
- 一个可以转发到本机 OpenTag Slack ingress 的公网 URL。
- Slack Signing Secret。
- Slack Bot User OAuth Token。
- 一个用于测试的 Slack channel。

本地测试时，可以先用 tunnel 暴露 OpenTag：

```bash
ngrok http 3040
```

Slack 的 Request URL 应该长这样：

```text
https://<你的 tunnel 域名>/slack/events
```

### 配置 Events API

1. 在 [Slack API Apps](https://api.slack.com/apps) 里打开你的 app。
2. 进入 **Basic Information** -> **App Credentials**，复制 **Signing Secret**。
3. 进入 **OAuth & Permissions**，添加同样的 bot scopes：
   - `app_mentions:read`
   - `chat:write`
4. 安装或重新安装 app。
5. 进入 **Event Subscriptions**。
6. 打开事件订阅。
7. 填入 Request URL：

```text
https://<你的 tunnel 域名>/slack/events
```

8. 在 **Subscribe to bot events** 里添加：
   - `app_mention`
9. 保存设置。

这条 Events API 路线不要开启 Socket Mode，否则你会调错接入方式。

## 找到 Team ID 和 Channel ID

OpenTag 会继续问：

```text
Slack Team ID
Slack Channel ID
```

最简单的获取方式：

1. 用浏览器打开 Slack。
2. 进入目标 channel。
3. 复制浏览器地址栏里的 channel URL，它通常包含这两个 ID：

```text
https://app.slack.com/client/T0123456789/C0123456789
```

在这个例子里：

- Team ID 是 `T0123456789`
- Channel ID 是 `C0123456789`

测试前记得把 Slack app 邀请进这个 channel。

## 测试

setup 完成后启动 OpenTag：

```bash
opentag start
```

然后在绑定的 Slack channel 里 mention 这个 app：

```text
@OpenTag summarize this thread
```

OpenTag 应该会先确认收到请求，执行完成后再回到同一个 Slack thread 里回复。

如果回复里出现 pull request action，但你的配置里只有 Slack 凭据，OpenTag 会创建一个 follow-up run，而不是直接创建 GitHub PR。想让 Slack 里的 `apply 1` 直接创建 PR，需要先配置 GitHub repository target。
