# Slack 配置教程

当 `opentag setup` 询问 Slack 配置时，用这份教程对照填写。

## 你需要准备什么

- 一个安装到 Slack workspace 的 Slack App。
- 一个可以转发到本机 OpenTag Slack ingress 的公网 URL。
- 一个用于测试的 Slack channel。

本地测试时，可以先用 tunnel 暴露 OpenTag：

```bash
ngrok http 3040
```

Slack 的 Request URL 应该长这样：

```text
https://<你的 tunnel 域名>/slack/events
```

## 创建 Slack App

1. 打开 [Slack API Apps](https://api.slack.com/apps)。
2. 创建一个新的 app，选择 **From scratch**。
3. 选择要测试的 workspace。
4. 进入 **Basic Information**，复制 **Signing Secret**。

OpenTag 里对应这个字段：

```text
Slack Signing Secret
```

## 添加 Bot 权限

1. 进入 **OAuth & Permissions**。
2. 在 **Bot Token Scopes** 里添加：
   - `app_mentions:read`
   - `chat:write`
3. 安装或重新安装 app 到 workspace。
4. 复制 **Bot User OAuth Token**。它一般以 `xoxb-` 开头。

OpenTag 里对应这个字段：

```text
Slack Bot User OAuth Token
```

## 开启 Events

1. 进入 **Event Subscriptions**。
2. 打开事件订阅。
3. 填入 Request URL：

```text
https://<你的 tunnel 域名>/slack/events
```

4. 在 **Subscribe to bot events** 里添加：
   - `app_mention`
5. 保存设置。

这里要用 Events API 的 Request URL。这个本地配置路径不要开启 Socket Mode，否则你会调错接入方式。

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
