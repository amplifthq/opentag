# GitHub 配置教程

当 `opentag setup` 询问 GitHub 配置时，用这份教程对照填写。

OpenTag CLI 当前使用 **Repository Webhook** 接入 GitHub。这是最小正确的 MVP 路线：GitHub 把 issue 和 pull request 评论通过公网 tunnel 发到你本机的 OpenTag，OpenTag 再运行本地 coding agent，并把结果回写到 GitHub。

当 coding agent 修改了文件时，OpenTag 默认会走这个流程：

1. 先把这次 run 的代码改动推到一个临时 run branch。
2. 在同一个 GitHub thread 里展示一个 `create_pull_request` 建议动作。
3. 只有当你回复 `apply 1` 后，OpenTag 才会真正创建 pull request。

这样用户始终有最后确认权。旧的“每次 run 结束立刻自动创建 PR”模式仍然保留为高级选项，但不是默认 setup 路线。

GitHub App 安装模式是长期产品路线，但还不是当前 CLI 的默认 setup 路线。

## 官方文档

- [Creating repository webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Managing fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Create a fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)

## OpenTag 会帮你做什么

OpenTag setup 会处理本地能安全自动化的部分：

- 尽量从当前项目的 `origin` remote 推断 GitHub 仓库。
- 自动生成强随机 webhook secret。
- 写入本地 dispatcher、GitHub webhook listener、runner 和仓库绑定配置。
- 默认开启 run branch preparation，这样你后续回复 `apply 1` 时才能创建 PR。
- `opentag start` 会启动本地 GitHub webhook listener。

## 你还需要做什么

GitHub 访问不到你电脑上的 `localhost`。你仍然需要：

- 一个公网 tunnel，把 GitHub 请求转发到本机 OpenTag。
- 一个 GitHub repository webhook，Payload URL 指向这个公网 tunnel。
- 一个 GitHub token，让 OpenTag 能回写评论，并在你回复 `apply 1` 后创建 PR。
- 本机 git remote 凭据需要能往这个仓库 push branch。OpenTag 会使用当前项目的 `origin` remote 推送 run branch。

## 1. 运行 setup

运行：

```bash
opentag setup
```

选择：

```text
GitHub
```

OpenTag 会问：

```text
GitHub 仓库（owner/repo）
允许 OpenTag 在 run 结束后立刻自动创建 pull request 吗？
本地 GitHub webhook 端口
GitHub token（用于回写评论和创建 PR）
```

Webhook secret 由 OpenTag 自动生成，你不用自己想。

CLI 默认本地 webhook 端口是 `3050`。如果这台电脑上已经有别的服务占用了这个端口，可以换一个：

```bash
opentag setup --platform github --github-port 3051 --force
```

## 2. 创建 GitHub Token

OpenTag 会用这个 token 回写 acknowledgement、progress 和 final result 评论。你在 GitHub thread 里回复 `apply 1` 后，它也会用这个 token 创建 pull request。

1. 打开 [GitHub token 创建页](https://github.com/settings/personal-access-tokens/new)。
2. 如果 GitHub 询问 token 类型，选择 **Generate new token**。
3. 填一个容易识别的名字，例如 `OpenTag local agent`。
4. 在 **Repository access** 里选择 **Only select repositories**，只选择你在 `opentag setup` 里填写的仓库。
5. 在 **Repository permissions** 里设置：
   - **Issues**: Read and write
   - **Pull requests**: Read and write
6. 默认的 `apply 1` 流程不需要 **Contents** 权限，因为 run branch 会用你本机的 git remote 凭据推送。如果你开启了旧的“run 结束立刻自动创建 PR”模式，还需要：
   - **Contents**: Read and write
7. 点击 **Generate token**。
8. 立即复制 token。GitHub 只会显示一次。
9. 把 token 粘贴到 `GitHub token（用于回写评论和创建 PR）` 这个输入项里。

默认 setup 不需要 webhook 管理权限。除非未来你明确要让 OpenTag 自动创建 GitHub webhook，否则不要额外授予 webhook administration 权限。

## 3. 创建公网 tunnel

先启动 OpenTag：

```bash
opentag start
```

然后用 tunnel 暴露 GitHub listener，例如：

```bash
ngrok http 3050
```

OpenTag 本地监听地址是：

```text
http://127.0.0.1:3050/github/webhooks
```

GitHub webhook 的 Payload URL 要使用公网 tunnel 域名：

```text
https://<你的 tunnel 域名>/github/webhooks
```

## 4. 创建 Repository Webhook

GitHub 官方教程是 [Creating repository webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)。

1. 打开 GitHub 仓库。
2. 进入 **Settings** -> **Webhooks**。
3. 点击 **Add webhook**。
4. **Payload URL** 填：

```text
https://<你的 tunnel 域名>/github/webhooks
```

5. **Content type** 选择 `application/json`。
6. **Secret** 填 `opentag setup` 输出的 webhook secret。
7. 订阅这些事件：
   - **Issue comments**
   - **Pull request review comments**
8. 保存 webhook。

保存后，GitHub 会在这个 webhook 页面展示最近的 delivery。后面如果 OpenTag 没反应，优先到这里看 GitHub 有没有把事件发出来。

## 测试

setup 完成、`opentag start` 运行中、GitHub webhook 创建完成后，在 issue 或 pull request review thread 里评论：

```text
@opentag investigate this
```

预期结果：

1. GitHub 把评论 webhook 发到你的 tunnel。
2. OpenTag 创建一次 run。
3. 本地 runner 执行 coding agent。
4. OpenTag 把 acknowledgement、progress 和 final result 回写到同一个 GitHub thread。
5. 如果 agent 修改了文件，OpenTag 会推送 run branch，并展示 `create_pull_request` 建议动作。
6. 你在 thread 里回复 `apply 1` 后，OpenTag 创建 pull request。

## 如果没有跑通

先检查这些：

- 如果 OpenTag 提示 webhook 端口被占用，用 `--github-port <空闲端口>` 重新 setup，并让 tunnel 指向同一个端口。
- tunnel 是否还在运行，并且指向 `opentag start` 显示的本地 GitHub webhook 端口，通常是 `3050`。
- GitHub webhook 的 Payload URL 是否以 `/github/webhooks` 结尾。
- webhook content type 是否是 `application/json`。
- webhook secret 是否和 OpenTag 保存的完全一致。
- webhook 是否订阅了 **Issue comments** 和 **Pull request review comments**。
- GitHub token 是否有 Issues 和 Pull requests 写权限。
- 如果你期待 `apply 1` 创建 PR，本机 `origin` remote 是否能 push branch。
- `opentag start` 是否还在运行。
