<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/readme-logo-light.png">
    <img src="./assets/readme-logo-light.png" alt="OpenTag logo" width="112" />
  </picture>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <b>简体中文</b>
</p>

# OpenTag

**[opentag.im](https://opentag.im)**

**把 Slack、GitHub 或 Lark 连接到你本地的 coding agent。**

[![Release](https://img.shields.io/github/v/release/amplifthq/opentag?include_prereleases&label=release)](https://github.com/amplifthq/opentag/releases)
[![npm](https://img.shields.io/npm/v/@opentag/cli?label=%40opentag%2Fcli)](https://www.npmjs.com/package/@opentag/cli)
[![pnpm build](https://img.shields.io/github/actions/workflow/status/amplifthq/opentag/ci.yml?branch=main&label=pnpm%20build)](https://github.com/amplifthq/opentag/actions/workflows/ci.yml)
[![pnpm typecheck](https://img.shields.io/github/actions/workflow/status/amplifthq/opentag/ci.yml?branch=main&label=pnpm%20typecheck)](https://github.com/amplifthq/opentag/actions/workflows/ci.yml)
[![pnpm test](https://img.shields.io/github/actions/workflow/status/amplifthq/opentag/ci.yml?branch=main&label=pnpm%20test)](https://github.com/amplifthq/opentag/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](#许可证)

OpenTag 让团队可以在已经使用的协作软件里提及一个 coding agent。它可以监听 Slack、GitHub 或 Lark / 飞书，在你的电脑上运行 Codex 或 Claude Code，然后把结果回复回原来的地方。

## 演示

在 Slack 里提及 OpenTag，审批建议动作，然后得到一个真实的 GitHub pull request。

https://github.com/user-attachments/assets/86edc4e1-7de9-4d07-a0ba-847fa6438191

![OpenTag overview](./assets/readme-hero.png)

## 快速开始

需要 Node.js 20 或更新版本。

```bash
npm install -g @opentag/cli
opentag setup
opentag doctor
```

不想全局安装：

```bash
npx @opentag/cli setup
npx @opentag/cli doctor
```

`opentag setup` 是主要入口。它会问你四个实际问题：

1. OpenTag 要监听哪里？
2. OpenTag 要使用哪个 coding agent？
3. OpenTag 可以操作哪个本地项目？
4. OpenTag 要保存哪些平台凭据？

setup 保存配置后，会顺便问你要不要现在启动 OpenTag。如果当时没有启动，或者后来关掉了终端，再手动运行 `opentag start`。

OpenTag 启动后，在已连接的平台里提及它：

```text
@opentag investigate this
```

OpenTag 会在本地运行你选择的 coding agent，并通过对应的平台回复结果。

## 让 Agent 帮你

如果你已经在用 Codex 或 Claude Code，但不熟悉 CLI，可以新开一个 agent session，直接粘贴：

```text
请帮我从 https://github.com/amplifthq/opentag 设置 OpenTag。

请使用已发布的 OpenTag CLI。请你：
1. 检查这台电脑是否已经安装 Node.js 20 或更高版本。
2. 安装或运行已发布的 OpenTag CLI。
3. 运行 opentag setup，并帮我选择 Slack、GitHub 或 Lark / Feishu、coding agent，以及本地项目。
4. 如果需要平台凭据，请打开仓库里对应的平台设置教程，并一步一步带我完成。
5. setup 询问是否现在启动 OpenTag 时，请帮我选择启动。如果当时跳过了，或者后面需要重新启动，再运行 opentag start。然后用 opentag status 或 opentag doctor 验证设置是否成功。

不要编造凭据或密钥。输入任何 token、app ID、channel ID、repository 或 project path 之前，都要先问我。
```

## 平台教程

在 `opentag setup` 里选择哪个平台，就看对应教程。

| 平台 | 推荐首选路径 | 教程 |
| --- | --- | --- |
| Slack | 本地开发优先使用 Socket Mode | [Slack 配置](docs/platforms/slack.zh-CN.md) |
| GitHub | 使用 repository webhook 和 GitHub token | [GitHub 配置](docs/platforms/github.zh-CN.md) |
| Lark / 飞书 | 在 setup 里扫码创建 Personal Agent | [Lark / 飞书配置](docs/platforms/lark.zh-CN.md) |

OpenTag 也有实验性的 Telegram adapter，但 CLI setup 还没有接入。

## 本地会运行什么

`opentag setup` 最后可以直接帮你启动本地前台进程。`opentag start` 是手动启动或重新启动时用的命令。它会启动：

- 本地 dispatcher
- 绑定到你所选项目的本地 runner
- 已选择的平台监听器

停止它：

```text
Ctrl-C
```

OpenTag 本地配置默认写到：

```text
~/.config/opentag/config.json
```

Runtime state 和隔离 worktree 默认写到：

```text
~/.local/state/opentag
```

## 隐私和本地优先

OpenTag 的 CLI 路径是本地优先的。

- 本地 CLI 流程里没有 OpenTag cloud service。
- 平台凭据保存在你的电脑上，并使用私有文件权限。
- Codex 和 Claude Code 会在你的本地 checkout 上运行。
- 平台 API 只会收到 OpenTag 用来确认、回复和执行已审批 action 所需的消息。

## 支持的 Coding Agent

| Coding agent | 状态 | 说明 |
| --- | --- | --- |
| Codex | 已支持 | 使用本机的 `codex` 命令 |
| Claude Code | 已支持 | 使用本机的 `claude` 命令 |
| Echo | 仅开发/测试 | 不运行真实 coding agent |

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `opentag setup` | 创建或更新本地 OpenTag 配置，并询问是否立即启动 |
| `opentag start` | 手动启动或重新启动本地 OpenTag stack |
| `opentag status` | 查看本地配置和运行状态 |
| `opentag doctor` | 做更深入的 setup 检查 |
| `opentag platforms` | 查看平台 setup 支持状态 |
| `opentag executors` | 查看可用 coding agent |
| `opentag config path` | 输出本地配置文件路径 |
| `opentag config show` | 输出脱敏后的本地配置 |

## 卸载

移除全局 CLI 包：

```bash
npm uninstall -g @opentag/cli
```

删除本地 OpenTag 配置和状态：

```bash
rm -rf ~/.config/opentag ~/.local/state/opentag
```

## 工作方式

```mermaid
flowchart LR
    A["Slack、GitHub 或 Lark"] --> B["OpenTag listener"]
    B --> C["本地 dispatcher"]
    C --> D["本地 runner"]
    D --> E["Codex、Claude Code 或自定义 executor"]
    E --> F["回复回对应平台"]
```

最重要的边界是：平台负责接收和回复消息，OpenTag 负责任务调度，coding agent 在你的电脑上执行。

## 开发者文档

- [平台配置教程](docs/platforms/README.md)
- [配置说明](docs/configuration.md)
- [适配器开发](docs/adapter-authoring.md)
- [真实集成 smoke test](docs/real-integration-smoke-test.md)
- [Agent Work Protocol](docs/agent-work-protocol.md)
- [本地 npm 发布指南](docs/npm-release.md)

## 本地开发

从源码运行：

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

安装本地开发命令：

```bash
corepack pnpm opentag-dev
opentag-dev setup
```

## 软件包

当前公开发布版本：`v0.2.0`。OpenTag 的 npm 包发布在 `@opentag` scope 下。

| 包 | 用途 |
| --- | --- |
| [`@opentag/cli`](https://www.npmjs.com/package/@opentag/cli) | setup 和本地 runtime CLI |
| [`@opentag/local-runtime`](https://www.npmjs.com/package/@opentag/local-runtime) | 进程内本地 dispatcher、runner 和平台 runtime |
| [`@opentag/core`](https://www.npmjs.com/package/@opentag/core) | 协议 schema、类型、mention 解析和 JSON Schema 导出 |
| [`@opentag/client`](https://www.npmjs.com/package/@opentag/client) | Dispatcher HTTP client |
| [`@opentag/slack`](https://www.npmjs.com/package/@opentag/slack) | Slack Socket Mode、Events API 和回复 |
| [`@opentag/github`](https://www.npmjs.com/package/@opentag/github) | GitHub webhook、评论、PR helper 和 action apply |
| [`@opentag/lark`](https://www.npmjs.com/package/@opentag/lark) | Lark / 飞书入口、Personal Agent 注册和回复 |
| [`@opentag/runner`](https://www.npmjs.com/package/@opentag/runner) | Executor 契约，以及 Echo、Claude Code、Codex 适配器 |
| [`@opentag/store`](https://www.npmjs.com/package/@opentag/store) | SQLite 持久化 |
| [`@opentag/dispatcher`](https://www.npmjs.com/package/@opentag/dispatcher) | 可嵌入 dispatcher 和 callback sink |

## 许可证

OpenTag 基于 MIT License 开源。详见 [LICENSE](LICENSE)。

## 交流微信群

🎉 欢迎大家在群里交流：
• 使用体验/bug 反馈
• 功能建议/场景需求
• 开源贡献与共创想法

我们会在群里同步项目进展和版本更新。欢迎大家一起玩、一起提 issue、一起把 OpenTag 做得更好！👏

<img width="939" height="1455" alt="img_v3_02134_6a2eaf32-fa30-481c-8a74-a1827bf1a6hu" src="https://github.com/user-attachments/assets/43604f5e-4f1d-4ad4-9a7d-a79832c54a28" />
