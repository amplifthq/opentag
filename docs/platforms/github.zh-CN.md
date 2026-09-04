# GitHub Project Target

## 支持 profile

GitHub 是 OpenTag 唯一的 Project Target 以及 publication/readback provider，
不是 Source App。Slack 提供 source conversation；自托管 Control Plane 治理 Run；
配对 Runner 针对配置好的 GitHub repository 执行已批准的工作。

```text
Slack source thread
        |
        v
Control Plane -> Run -> Attempt -> 配对 Runner
                                      |
                           GitHub target / draft PR publication
                                      |
                             exact-head readback evidence
```

GitHub readback 是 completion gate 的 evidence，不拥有 Run state、Attempt lease、
approval、cancellation 或 terminal outcome。

## Target 配置

在配对 Runner 的 repository binding 中配置一个明确 target：

```text
provider: github
owner: acme
repo: demo
base branch: main
publication: governed draft pull request
```

Target identity 必须精确。Run 不得向当前 target 和已批准 proposal 之外的 repository、
branch 或 pull request publication。GitHub credential 保存在 Runner 的受保护存储中；
不得写入 Slack message、source event、ACP prompt 或持久化 presentation payload。

## 受治理的 draft pull-request publication

标准流程：

1. ACP Agent 在 Runner-owned workspace 中准备变更。
2. OpenTag 将 changed files、branch、verification summary 和 target 记录为 proposal。
3. Source thread 呈现包含 impact、preconditions、capability state 和 approval requirement
   的 action receipt。
4. 人工批准当前且精确的 proposal。
5. Control Plane 在 provider I/O 前检查 Run/Attempt fencing、target identity、proposal hash、
   policy 和 idempotency。
6. Runner 执行 GitHub publication 并记录 material-action receipt。
7. OpenTag 对 exact head 和 provider evidence 做 readback，之后才可把 publication 视为完成。

Approval 不等于 publication。本地 branch 或生成的 patch 不等于 pull request。Pull request
URL 也不等于 expected head 或 checks 仍然正确的证明。

## Exact-head readback

Readback 必须标识正在评估的精确 GitHub resource 和 revision：

- repository `owner/repo`；
- pull-request number 或其他稳定 resource identity；
- head commit SHA；
- base branch 或 target ref；
- required-check conclusion 和 observation time；
- 每条 observation 的 assurance level 和来源。

如果 approval 后 head 发生变化，原 proposal 已过期，不得静默 publication 或标记完成。
如果 GitHub 接受请求但结果无法验证，必须保留 `outcome_unknown`，先 reconcile，再考虑重试。

## Action receipt 与失败状态

GitHub publication 是带稳定 idempotency key 的 material action。Receipt 至少要区分：

- proposal 已准备但尚未批准；
- approval 已记录但尚未发生 provider I/O；
- publication 成功，并在 exact expected head 上完成 readback；
- 被 policy、capability 或 target mismatch 拒绝；
- provider failure；
- provider result 不明确：`outcome_unknown`。

不得从本地进程退出、queued intent、过期缓存页面或未验证的 provider response 推断
“merged”“published”或“checks passed”。

## 本文不覆盖

- GitHub 作为 Source App 或 conversation ingress；
- 自动 push branch、merge、deployment 或 release；
- 未经审核的 pull-request creation；
- 一次 governed publication 使用多个 Project Target；
- 将 provider credential 放入 Agent prompt；
- 将 GitHub UI state 当作 OpenTag canonical lifecycle。

## 官方链接

- [GitHub REST API](https://docs.github.com/en/rest)
- [Pull requests REST API](https://docs.github.com/en/rest/pulls/pulls)
- [Checks API](https://docs.github.com/en/rest/checks/runs)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [GitHub pull-request review](https://docs.github.com/en/pull-requests)

## 相关 OpenTag 文档

- [Slack Source App](slack.en.md)
- [Source-thread action receipts](../source-thread-action-receipts.md)
- [Control Plane runtime architecture](../control-plane-runtime-architecture.md)
- [ACP agent integration](../acp-agent-integration.md)
