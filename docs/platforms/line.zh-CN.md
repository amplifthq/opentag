# LINE Messenger 配置

在 `opentag setup` 询问 LINE 凭据时使用这份教程。

OpenTag 使用文本版 LINE Messaging API webhook。LINE 通过公网 tunnel 把消息事件发到本地 OpenTag，OpenTag 在本机运行所选 coding agent，然后用 LINE push message API 回复最终结果。

当前 MVP 不包含媒体理解、Flex message、rich menu 或聊天内 `/bind`。setup 时绑定一个 LINE 用户、群组或聊天室。

## 官方链接

- [LINE Developers Console](https://developers.line.biz/console/)
- [Receiving messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Sending messages](https://developers.line.biz/en/docs/messaging-api/sending-messages/)

## 需要准备

- 一个已启用 Messaging API 的 LINE Official Account。
- Channel secret。
- Channel access token。
- 一个指向本地 LINE listener 的公网 tunnel。
- 要绑定的 LINE 会话 ID：使用 `auto`，或填写 `source.userId`、`source.groupId`、`source.roomId`。

## 1. 找到 Conversation ID

LINE webhook 事件里会带 source ID。使用：

- 私聊：`source.userId`
- 群聊：`source.groupId`
- Room：`source.roomId`

如果还不知道这个值，setup 时填写 `auto`。OpenTag 会把到达 webhook 且签名有效的 LINE 用户、群组或 room 绑定到所选项目。

## 2. 运行 Setup

```bash
opentag setup --platform line
```

OpenTag 会询问：

```text
LINE account ID
LINE channel secret
LINE channel access token
LINE conversation ID
Local LINE webhook port
```

默认本地端口是 `3070`。

## 3. 创建公网 Tunnel

启动 OpenTag，然后暴露 LINE listener：

```bash
opentag start
ngrok http 3070
```

本地 webhook 是：

```text
http://localhost:3070/line/events/<accountId>
```

LINE Console 里的 webhook URL 使用 tunnel 域名：

```text
https://<your-tunnel-host>/line/events/<accountId>
```

## 4. 配置 LINE Console

1. 打开 [LINE Developers Console](https://developers.line.biz/console/)。
2. 打开你的 Messaging API channel。
3. 复制 **Channel secret** 到 setup。
4. 创建或复制 **Channel access token** 到 setup。
5. 把 **Webhook URL** 设为 `https://<your-tunnel-host>/line/events/<accountId>`。
6. 启用 **Use webhook**。

LINE 会用 `x-line-signature` 签名 webhook 请求。OpenTag 会先校验原始 request body，再解析 JSON。

把 `auto` 或 source ID 填到 setup 的 `LINE conversation ID`。OpenTag 会写入 `provider: "line"` 的通用 channel binding，让本地 dispatcher 把消息路由到所选 Project Target。

## 5. 测试

私聊消息会直接作为命令。群聊或 room 里需要 @ 机器人，或以 `/opentag` 开头：

```text
/opentag investigate this
```

OpenTag 会在同一个 LINE 会话里用纯文本回复。
