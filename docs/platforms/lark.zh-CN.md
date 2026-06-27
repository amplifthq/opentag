# Lark / 飞书配置教程

当 `opentag setup` 询问 Lark / 飞书连接方式时，用这份教程对照选择。

## 官方入口

- [Lark 开发者后台](https://open.larksuite.com/app)
- [飞书开发者后台](https://open.feishu.cn/app)
- [如何获取 App ID 和 App Secret](https://open.larksuite.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-app-id)
- [Lark 长连接 / WebSocket 事件](https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket)
- [飞书长连接 / WebSocket 事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/use-websocket?lang=zh-CN)

## 推荐方式：扫码创建 Personal Agent

最简单的方式是：

```text
创建新的 Personal Agent
```

OpenTag 会显示一个二维码。用 Lark 或飞书扫码，完成 Personal Agent app 创建，然后保持终端打开。app 创建成功后，OpenTag 会自动继续 setup。

除非你已经有自己维护的 Lark / 飞书自建应用，否则优先选这个方式。

## 使用已保存的 Personal Agent

如果这台电脑上已经保存过 Personal Agent，setup 会显示：

```text
使用已保存的 Personal Agent
```

CLI 会显示一些安全信息，例如域名、App ID 前后缀、Bot Open ID 前后缀，以及这个配置来自哪里。App Secret 不会被打印出来。

如果你想复用之前创建过的 app，就选这个。

## 手动填写凭据

只有当你已经有 Lark / 飞书自建应用时，才选手动填写。

OpenTag 会问：

```text
Lark App ID
Lark App Secret
Lark Bot Open ID（可选）
```

App ID 和 App Secret 可以在 Lark / 飞书开发者后台找到：

1. 打开你租户对应的后台：
   - Lark: [https://open.larksuite.com/app](https://open.larksuite.com/app)
   - 飞书: [https://open.feishu.cn/app](https://open.feishu.cn/app)
2. 打开你的应用。
3. 进入 **Credentials & Basic Info / 凭证与基础信息**。
4. 复制 **App ID** 和 **App Secret**，填回 OpenTag。

这个应用需要支持 bot 消息和长连接事件。如果你不确定这些是什么，直接用扫码创建 Personal Agent 会更稳。

## 域名

OpenTag 会问你使用哪个域名：

- `Lark` 对应 larksuite.com
- `Feishu` 对应 feishu.cn

选择你创建 app 时所在的域名。

## 测试

setup 完成后启动 OpenTag：

```bash
opentag start
```

然后在 Lark / 飞书里向 Personal Agent 发消息或 mention 它。OpenTag 应该会收到消息，在本机运行你选择的 coding agent，然后回到同一个会话里回复。
