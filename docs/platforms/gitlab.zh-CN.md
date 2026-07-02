# GitLab 配置

当 `opentag setup --platform gitlab` 要求填写 GitLab 信息时，按这份指南配置。

## 需要准备

- GitLab project path，例如 `acme/demo` 或 `acme/team/demo`。
- 一个 GitLab personal access token 或 project access token，scope 至少包含 `api`，用于让 OpenTag 回写 issue / merge request note，并在 `apply 1` 后创建 merge request。
- 一个公网 tunnel URL，用来把 GitLab webhook 转发到本地 OpenTag 进程。
- 如果使用自托管 GitLab，需要实例 base URL，例如 `https://gitlab.example.com`。

## 创建 Token

GitLab.com 打开：

```text
https://gitlab.com/-/user_settings/personal_access_tokens
```

自托管 GitLab 打开：

```text
https://<your-gitlab-host>/-/user_settings/personal_access_tokens
```

推荐 token scope：

- `api`：用于通过 GitLab Notes API 创建 issue / merge request 评论，并在 `apply 1` 后通过 GitLab Merge Requests API 创建 MR。

请妥善保存 token。OpenTag 会把它写入本地配置文件，并在 `opentag status` 和 `opentag doctor` 中自动打码。

## 运行 OpenTag Setup

GitLab.com：

```bash
opentag setup \
  --platform gitlab \
  --gitlab-project acme/demo
```

自托管 GitLab：

```bash
opentag setup \
  --platform gitlab \
  --gitlab-base-url https://gitlab.example.com \
  --gitlab-project acme/team/demo
```

setup 会保存：

- `platforms.gitlab.projectPathWithNamespace`
- `platforms.gitlab.baseUrl`
- `platforms.gitlab.token`
- `platforms.gitlab.webhookSecret`
- `platforms.gitlab.webhookPath`
- `platforms.gitlab.port`

同时，setup 会把这个 GitLab Project Target 绑定到当前本地 checkout，这样来自 GitLab issue / merge request 的 `@opentag` 请求能路由到本地 runner。

## 配置 Project Webhook

打开项目 webhook 设置页：

```text
https://gitlab.com/<group>/<project>/-/hooks
```

如果是自托管 GitLab，把 `https://gitlab.com` 替换成你的 `--gitlab-base-url`。

填写：

- URL：公网 tunnel URL 加 OpenTag webhook path，例如 `https://<your-tunnel-host>/gitlab/webhooks`。
- Secret token：`opentag setup` 输出的 secret token。
- Trigger：启用 `Note events`。
- SSL verification：如果 tunnel 或部署端有有效 HTTPS 证书，建议开启。

GitLab 会通过 Note Hook payload 发送 issue 和 merge request 评论。OpenTag 会监听 `@opentag` mention，把 payload 归一化为 OpenTag event protocol，并通过 GitLab Notes API 回写同一个 thread。

## 启动和测试

启动 OpenTag：

```bash
opentag start
```

如果使用本地 tunnel，把 tunnel 转发到 setup 输出的 GitLab webhook 端口。默认端口是：

```bash
ngrok http 3060
```

然后在 GitLab issue 或 merge request 里评论：

```text
@opentag investigate this failing test
```

预期行为：

- OpenTag 接收 Note Hook delivery。
- 本地 runner 针对绑定的 checkout 启动。
- OpenTag 在同一个 GitLab issue 或 merge request thread 中回复结果。

run 进行中时，你可以在同一个 source thread 里检查或停止 runtime：

```text
@opentag /status
@opentag /doctor
@opentag /stop [run_id]
```

这些控制命令只报告或取消 source-thread runtime 状态，不会再创建一次 run。

## Relay 模式

GitLab relay 模式适用于你自己运营的 relay，或者已经确认配置了 GitLab webhook 能力的 relay。不要把 GitLab project webhook 指向一个泛用 hosted relay，除非 relay 运营方明确确认 `/gitlab/webhooks` 已启用，并且已经配置匹配的 GitLab secret。没有 relay 侧配置时，请使用本地 `opentag start` 加公网 tunnel。

对于已配置好的 relay，把 GitLab project webhook 指向 relay URL 加 GitLab webhook path：

```text
https://<你的 relay 域名>/gitlab/webhooks
```

自托管或自定义 relay 端需要配置：

- `OPENTAG_GITLAB_WEBHOOK_SECRET`：GitLab 通过 `X-Gitlab-Token` 发送的 shared secret。
- `OPENTAG_GITLAB_BASE_URL`：自托管 GitLab 需要配置；GitLab.com 可省略。
- `OPENTAG_GITLAB_TOKEN`：用于 source-thread 回写，以及 `apply 1` 后直接创建 merge request。

当 config 中包含 GitLab 时，`opentag pair --relay <url>` 和 `opentag start` 会打印 GitLab relay webhook URL。只有确认 relay 已配置上面的 GitLab 环境变量后，才把这个 URL 当成可用 webhook 地址。

## 当前范围

当前已支持：

- CLI 中配置 GitLab 项目。
- 本地 `opentag start` 启动 GitLab webhook ingress。
- 自托管或自定义 relay 端配置 GitLab token 和 webhook secret 后，在 `/gitlab/webhooks` 接收 GitLab webhook。
- 通过 `--gitlab-base-url` 支持 GitLab.com 和自托管 GitLab。
- 监听 issue note 和 merge request note 中的 `@opentag`。
- 通过 Notes API 回写原始 issue / merge request。
- run 进行中更新同一条 GitLab status note，而不是每个状态都创建一条新的 progress note。
- 对支持的 `create_pull_request` action receipt，在 `apply 1` 后直接创建 GitLab merge request。
- 当 dispatcher 有支持的 action receipt 时，支持 `apply 1`、`approve 1`、`continue 1`、`reject 1` 等 thread action 命令。
- 支持 `@opentag /status`、`@opentag /doctor`、`@opentag /stop [run_id]` 等 source-thread 控制命令，并且不会创建新的 run。

暂未实现：

- 通过 GitLab Project Webhooks API 自动注册 webhook。

GitLab 的 API 能创建 project webhook，但 OpenTag 暂时不自动注册：安全的默认 setup 仍然需要操作者确认稳定公网 URL，并明确决定是否授予 webhook 管理权限。手动创建 webhook 能保持 token scope 更窄，也和当前 GitHub setup 边界一致。
