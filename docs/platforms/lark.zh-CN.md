# Lark/飞书配置教程

当 `opentag setup` 询问 Lark/飞书连接方式时，用这份教程对照选择。

## 官方入口

- [Lark 开发者后台](https://open.larksuite.com/app)
- [飞书开发者后台](https://open.feishu.cn/app)
- [如何获取应用 ID 和应用密钥（App ID / App Secret）](https://open.larksuite.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-app-id)
- [Lark 长连接（WebSocket）事件](https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket)
- [飞书长连接（WebSocket）事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/use-websocket?lang=zh-CN)

## 推荐方式：扫码创建个人代理应用

最简单的方式是：

```text
扫码创建个人代理应用
```

OpenTag 会显示一个二维码。这个设置链接可能从飞书 bootstrap 页面开始；如果你用 Lark 国际租户扫码，平台可以在扫码后切换。完成个人代理应用创建后保持终端打开，OpenTag 会继续设置，并保存平台返回的真实 Lark/飞书租户。

除非你已经有自己维护的 Lark/飞书自建应用，否则优先选这个方式。

## 使用已保存的个人代理应用

如果这台电脑上已经保存过个人代理应用，设置向导会显示：

```text
使用已保存的个人代理应用
```

命令行会显示一些安全信息，例如租户、应用 ID 前后缀、机器人 Open ID 前后缀，以及这个配置来自哪里。应用密钥不会被打印出来。

如果你想复用之前创建过的应用，就选这个。

## 手动填写凭据

只有当你已经有 Lark/飞书自建应用时，才选手动填写。

OpenTag 会问：

```text
Lark/飞书租户
Lark 应用 ID
Lark 应用密钥
Lark 机器人 Open ID（可选）
```

应用 ID 和应用密钥可以在 Lark/飞书开发者后台找到：

1. 打开你租户对应的后台：
   - Lark: [https://open.larksuite.com/app](https://open.larksuite.com/app)
   - 飞书: [https://open.feishu.cn/app](https://open.feishu.cn/app)
2. 打开你的应用。
3. 进入 **Credentials & Basic Info / 凭证与基础信息**。
4. 复制 **App ID** 和 **App Secret**，填回 OpenTag。

这个应用需要支持机器人消息和长连接事件。如果你不确定这些是什么，直接用扫码创建个人代理应用会更稳。
OpenTag 会在写入当前 CLI 配置前向平台验证复用的历史凭据和手动填写的应用凭据，
所以过期或错误的 app secret 会在 setup 阶段失败，而不是等到 service start 才暴露。

## 租户

只有手动填写已有应用时，OpenTag 才会询问这个应用属于哪个租户：

- `Lark` 对应 larksuite.com 租户
- `Feishu` 对应 feishu.cn 租户

选择你创建应用时所在的租户。扫码创建时不需要预选，OpenTag 会保存平台返回的结果。

如果用命令行配置已有应用，传 `--tenant feishu` 或 `--tenant lark`。手动配置时如果省略 `--tenant`，OpenTag 默认使用 `feishu`。

## 聊天内命令

OpenTag 在 Lark/飞书里的命令都围绕 Project Target，而不是本机绝对路径：

- `/bind <owner>/<repo>` 或 `/bind <provider>:<owner>/<repo>`：把当前会话连接到一个 Project Target。
- `/unbind confirm`：解除当前会话和 Project Target 的连接；不会删除本机 checkout 配置、仓库绑定或 allowlist。
- `/status`：查看当前绑定的 Project Target、真实 active run、排队 follow-up 和下一步安全操作。
- `/doctor`：查看脱敏后的 readiness 摘要。聊天里不会打印 secret 或本机路径。
- `/stop [run_id]`：请求取消当前会话里的 active run，或取消指定 run。OpenTag 不会把 stop 请求当成成功完成。

群聊里必须先 @ 机器人，命令或任务才会生效。私聊可以更宽松，但仍然通过 Project Target 绑定工作，不接受本机绝对路径。群聊里的 `/bind` 和 `/unbind confirm` 还需要命令发送者命中绑定管理员 allowlist：`OPENTAG_LARK_BINDING_ADMIN_OPEN_IDS`、`OPENTAG_LARK_BINDING_ADMIN_USER_IDS` 或 `OPENTAG_LARK_BINDING_ADMIN_UNION_IDS`。

新 run 创建后，OpenTag 默认会尽量减少刷屏：先发一条很短、可更新的状态卡；
如果任务被排队或等待审批，会更新这张卡；平台接受 card update 时，最终结果也会
patch 回同一张状态卡。普通 running/progress 更新默认留在 audit log 里，不刷进会话。
要看 active 状态和 audit detail，用聊天里的 `/status` 或本机的
`opentag status --run <run_id>`。如果平台拒绝更新卡片，OpenTag 仍以本机 audit
timeline 作为事实来源，并允许 callback delivery 重试。

## 测试

设置完成后启动 OpenTag：

```bash
opentag start
```

然后在 Lark/飞书里向个人代理应用发消息，或在群聊里 @ 它。OpenTag 应该会先发简短状态卡，在本机运行你选择的编码代理，然后回到同一个会话里更新这张卡为最终结果。
