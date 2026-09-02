<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/readme-logo-light.png">
    <img src="./assets/readme-logo-light.png" alt="OpenTag logo" width="112" />
  </picture>
</p>

<p align="center"><a href="./README.md">English</a> · <b>简体中文</b></p>

# OpenTag

**提及任意编码智能体。拿到证据，而不是承诺。**

把 OpenTag relay 部署在你选择的基础设施上，配对一个本地 Runner，就能把 Slack
工程讨论串变成可治理、可核验的本地智能体工作。代码仓库、编码智能体凭据、worktree
与实际执行始终留在你控制的 Runner 上。

OpenTag 是自托管协调边界，不是托管编码服务。它接收讨论串请求，记录受治理的 Run
和 Attempt 状态，配对明确的 Runner，并把已核验状态投影回原 Slack 讨论串。Provider
delivery 是独立证据，不能取代 canonical Run 或 Attempt 的事实来源。

## 工作路径

1. 工程师在 Slack 工程讨论串中提及已配置的 OpenTag App。
2. 自托管 Control Plane 准入唯一的 **Run**，记录源讨论串、Project Target、授权与证据谱系。
3. 已配对本地 Runner 领取带 fence 的 **Attempt**，以本地 checkout 运行配置的 ACP executor。
4. Runner 回报有边界的证据；OpenTag 在原讨论串呈现状态、需关注状态或审批请求。
5. 创建 draft PR 等实质性 provider 动作必须满足精确策略与单独显式审批；智能体报告本身不会执行真实 provider 动作。

## 如实说明运行模式

| 模式 | 适用场景 | 可用性说明 |
| --- | --- | --- |
| `local_direct` | 试用、单机使用 | `offlineSafe=false`。只有该机器和本地 OpenTag 进程在线时才能工作。 |
| `paired_relay` | 自托管团队配置 | 独立运行的 relay 接收 Slack ingress，一个出站本地 Runner 执行已批准工作；精确安装认证另行进行。 |

参考单节点 Compose 配置只有在确定性与安装认证 gate 均通过后才可以显示
`Runner-offline-safe`。它始终是 `Relay-not-HA`；本仓库不作高可用声明。

## 快速开始：自托管 paired relay

团队配置使用 Slack Events API 与 Slack interactivity 的公网 HTTPS ingress、GitHub
Project Target、一个已配对本地 Runner 和 ACP executor。Socket Mode 仍适合
`local_direct` 本地开发，但**不属于**已认证的 paired relay ingress。

### 1. 启动你自行运维的 relay

需要 Docker Compose、Slack 可访问的公网 HTTPS origin，以及与配对 Runner 机器不同
的 relay 主机。

```bash
cd deploy/compose
cp .env.example .env
```

替换 `.env` 的每一个占位值。另建 mode `0600` 的 relay-content KEK 主机文件，内容必须
是恰好 32 个原始字节、64 个十六进制字符，或能解码为 32 字节的 base64。把路径写入
`OPENTAG_RELAY_CONTENT_KEK_SOURCE_FILE`。不要把 KEK 写进 `.env`：Compose 会将其挂载为
`/run/secrets/opentag_relay_content_kek`，key version 固定为 `v1`。

先渲染配置，再启动：

```bash
docker compose --env-file .env config
docker compose --env-file .env up --build
```

等待 `control-plane` 健康后使用 `OPENTAG_PUBLIC_URL`。恢复、readiness 和安装认证边界见
[Compose 指南](deploy/compose/README.md) 与 [部署运行手册](docs/control-plane-deployment.md)。

### 2. 配置 Slack Source App

为 workspace 和私有工程 channel 创建一个 Slack App。把 **Event Subscriptions** 与
**Interactivity & Shortcuts** 都指向 relay 的公网 HTTPS Slack endpoint，并在自托管安装
中配置 signing secret 和 bot token。订阅文档规定的 app-mention 与 private-channel 事件，
然后将 App 邀请进 channel。

请按 [Slack 指南](docs/platforms/slack.zh-CN.md) 配置精确事件、权限、URL 和验签流程。
不要将 Socket Mode 配置为认证后的 paired relay ingress。

### 3. 配对一个本地 Runner 与 Project Target

在持有 checkout 和 executor 的机器上：

```bash
npm install -g @opentag/cli@0.11.0
opentag setup --relay https://relay.example.com
opentag pair --relay https://relay.example.com \
  --trust-relay-origin https://relay.example.com
opentag start
```

`paired_relay` 会拒绝 loopback 和同进程 relay URL。setup 时注册本地 GitHub Project
Target，并选择机器可用的 ACP executor（例如 Codex 或 Claude Code）。配对 Runner 保留
checkout、编码智能体凭据与 worktree。

```bash
opentag doctor
opentag status
```

### 4. 从受治理的 Slack 请求开始

```text
@OpenTag 调查失败的检查并提出修复方案
```

确认消息只证明 ingress 已记录请求，不能证明 Runner 在线或工作完成。可在 Slack 查看
投影状态，或用 `opentag status --run <run_id>` 查本地审计详情。只审批策略呈现的精确
实质性动作。OpenTag 不自动合并、不盲目重试 `outcome_unknown` provider outcome，也不会
把完成证据变成 provider 动作。

## 当前支持的 profile

- Slack 是 Source App，负责讨论串 ingress、状态与审批呈现。
- GitHub 是 Project Target 与可选发布 provider，不是此 profile 的第二个 source ingress。
- 一个用户控制的配对 Runner 使用一个已配置 ACP executor。
- relay 负责持久协调和审计元数据；provider delivery 与 Run/Attempt 生命周期独立。

托管服务、高可用、ambient memory、scheduled work、多 Runner fallback、自动合并和未支持
的 Source App 均不在此 profile 的声明范围。详见 [team-relay 架构](docs/architecture/team-relay.md)
及需要单独授权的 [真实 canary 运行手册](docs/testing/team-relay-canary.md)。

## 验证本地实现

下列命令只验证已检入本地软件；不会部署 relay、联系 Slack/GitHub，也不构成安装认证：

```bash
corepack pnpm smoke:control-plane-compose:typecheck
corepack pnpm test
```

一次性的浏览器/Compose 验证边界见 [Control Plane README](apps/control-plane/README.md)。真实
Slack 或 GitHub canary 必须另行获得显式授权。

## 文档

- [Team relay 架构](docs/architecture/team-relay.md)
- [自托管 Compose 指南](deploy/compose/README.md)
- [Control Plane 部署运行手册](docs/control-plane-deployment.md)
- [Slack Source App 指南](docs/platforms/slack.zh-CN.md)
- [Team-relay canary 运行手册](docs/testing/team-relay-canary.md)
- [配置参考](docs/configuration.md)
- [面向智能体的安装指南](docs/agent-install.md)
- [npm prerelease 候选发布指南](docs/npm-prerelease.md)

## 许可证

[MIT](./LICENSE)
