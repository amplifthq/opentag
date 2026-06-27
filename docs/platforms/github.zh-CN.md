# GitHub 配置教程

当 `opentag setup` 询问 GitHub 配置时，用这份教程对照填写。

OpenTag CLI 当前使用 **Repository Webhook** 接入 GitHub。这是最小正确的 MVP 路线：GitHub 把 issue 和 pull request 评论通过公网 tunnel 发到你本机的 OpenTag，OpenTag 再运行本地 coding agent，并把结果回写到 GitHub。

GitHub App 安装模式是长期产品路线，但还不是当前 CLI 的默认 setup 路线。

## 官方文档

- [Creating repository webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Managing fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

## OpenTag 会帮你做什么

OpenTag setup 会处理本地能安全自动化的部分：

- 尽量从当前项目的 `origin` remote 推断 GitHub 仓库。
- 自动生成强随机 webhook secret。
- 写入本地 dispatcher、GitHub webhook listener、runner 和仓库绑定配置。
- `opentag start` 会启动本地 GitHub webhook listener。

## 你还需要做什么

GitHub 访问不到你电脑上的 `localhost`。你仍然需要：

- 一个公网 tunnel，把 GitHub 请求转发到本机 OpenTag。
- 一个 GitHub repository webhook，Payload URL 指向这个公网 tunnel。
- 一个 GitHub token，让 OpenTag 能回写评论；如果你允许自动创建 PR，还需要创建 PR 相关权限。

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
GitHub token（用于回写评论和创建 PR）
```

Webhook secret 由 OpenTag 自动生成，你不用自己想。

## 2. 创建公网 tunnel

先启动 OpenTag：

```bash
opentag start
```

然后用 tunnel 暴露 GitHub listener，例如：

```bash
ngrok http 3000
```

OpenTag 本地监听地址是：

```text
http://localhost:3000/github/webhooks
```

GitHub webhook 的 Payload URL 要使用公网 tunnel 域名：

```text
https://<你的 tunnel 域名>/github/webhooks
```

## 3. 创建 Repository Webhook

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

## 4. GitHub Token 权限

OpenTag 会用这个 token 回写 acknowledgement、progress 和 final result 评论。

如果使用 fine-grained personal access token，请授权到目标仓库，并打开：

- **Issues**: Read and write
- **Pull requests**: Read and write

如果你允许 OpenTag 在 coding agent 修改文件后自动创建 pull request，还需要：

- **Contents**: Read and write

默认 setup 不需要 webhook 管理权限。除非未来你明确要让 OpenTag 自动创建 GitHub webhook，否则不要额外授予 webhook administration 权限。

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

## 如果没有跑通

先检查这些：

- tunnel 是否还在运行，并且指向本机 `3000` 端口。
- GitHub webhook 的 Payload URL 是否以 `/github/webhooks` 结尾。
- webhook content type 是否是 `application/json`。
- webhook secret 是否和 OpenTag 保存的完全一致。
- webhook 是否订阅了 **Issue comments** 和 **Pull request review comments**。
- GitHub token 是否有 Issues 和 Pull requests 写权限。
- `opentag start` 是否还在运行。
