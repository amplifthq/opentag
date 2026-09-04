# Slack Source App

## 支持 profile

Slack 是 OpenTag 唯一支持的 Source App。当前支持的部署形态是自托管
`paired_relay`：

```text
Slack Events API + Interactivity
              |
              v
       自托管 Control Plane
              |
           一个配对 Runner
              |
            ACP executor
```

Control Plane 接收经过签名校验的 Slack 事件，解析 source channel/thread，
执行 admission，并呈现状态或 action receipt。配对 Runner 在本地执行 canonical
Run。Slack 对话状态是 Run/Attempt 事实的投影，不是执行队列，也不拥有完成权威。

GitHub 是唯一的 Project Target。Slack 请求可以标识 GitHub target，也可以展示
经过治理的 publication proposal；Slack 确认或 Agent 输出本身不会执行外部写操作。

## Slack app 要求

配置 Slack app：

- 开启 Events API；
- 配置指向自托管 Control Plane 的 HTTPS Request URL；
- 开启 Interactivity & Shortcuts，并使用同一个 Control Plane origin；
- 由 Control Plane 保存 signing secret，不得写入 source message；
- 只申请已部署 Slack adapter 所需的最小 bot scopes。

Control Plane 在解析请求前先验证原始 Slack signature，然后检查配置的 route、
workspace/application identity、event deduplication key 和当前 binding generation。
无效或过期事件 fail closed，不创建 Run。

## 用户流程

1. 部署自托管 Control Plane 和 PostgreSQL 数据库。
2. 只配对一个 Runner 到该 Control Plane。
3. 配置 Slack app 的 Events API Request URL 和 Interactivity URL。
4. 将 Slack workspace/channel 绑定到目标 GitHub Project Target。
5. 把 Slack app 邀请进 channel。
6. 在 thread 中 mention OpenTag。
7. 查看返回的状态、action receipt 或 attention 请求。
8. 只有在 target 和 preconditions 都正确时，才批准精确的 governed action。

常规进度保持有界且简洁；详细执行证据通过 Run/audit 投影查看，不直接灌入
Slack thread。

## Thread 与 attention 语义

Adapter 保留 Slack channel、message 和 thread identity。每个 source event 都关联
一个 canonical Run，或关联一个明确的 control action。Control Plane 可以投影：

- accepted 或 running 状态；
- completion 或 provider-evidence 摘要；
- 需要审批的 action receipt；
- 带安全下一步的 attention-required 状态；
- cancellation、failure 或 `outcome_unknown`。

Source-thread message 从来不是 provider side effect 成功的证明。若 provider I/O
可能已经发生但无法验证，Run 必须保留 `outcome_unknown`，thread 应要求先完成
reconcile，再考虑重试。

## Interactivity

Block Kit 按钮 **Apply**、**Approve**、**Continue**、**Reject** 提交的语义 action
与手动 source-thread command 相同。Control Plane 在执行 decision 前验证当前
Run、Attempt fence、proposal hash、preconditions 和 authority。

重复点击、过期消息、target 变化和 decision 过期必须被拒绝，或按幂等规则返回
已有结果。按钮 handler 不得直接调用 provider，也不得绕过 action receipt ledger。

## Credential custody

Slack signing secret 和 Slack app credentials 属于 Control Plane 配置。它们必须受
保护或加密存储，从 status 和日志中脱敏，且不得进入 ACP prompt。ACP Agent 不得
直接向 Slack 发消息。Source-thread delivery 由受治理的 Slack delivery boundary
依据当前 route 和 Run authority 执行。

## 官方链接

- [Slack API apps](https://api.slack.com/apps)
- [Events API](https://api.slack.com/apis/events-api)
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack interactivity](https://api.slack.com/interactivity)
- [Slack app scopes](https://api.slack.com/scopes)

## 运维边界

Slack 配置只证明 Source App route 已配置；它不证明 Runner 可用、ACP ready、
GitHub publication authority 或 completion evidence。这些事实必须来自各自当前
的 protocol record 和 provider observation。
