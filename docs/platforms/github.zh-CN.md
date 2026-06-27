# GitHub 配置教程

当 `opentag setup` 询问 GitHub 配置时，用这份教程对照填写。

## 你需要准备什么

- 一个 `owner/repo` 格式的 GitHub 仓库。
- 一个可以把 GitHub webhook 转发到本机 OpenTag GitHub ingress 的公网 URL。
- 一个 webhook secret。
- 一个能让 OpenTag 回写评论的 GitHub token。

本地测试时，可以先用 tunnel 暴露 OpenTag：

```bash
ngrok http 3000
```

GitHub webhook URL 应该长这样：

```text
https://<你的 tunnel 域名>/github/webhooks
```

## 仓库

OpenTag 会问：

```text
GitHub 仓库（owner/repo）
```

从 GitHub 仓库 URL 里取这部分：

```text
https://github.com/amplifthq/opentag
```

这个例子里应该填写：

```text
amplifthq/opentag
```

## Webhook Secret

1. 打开 GitHub 仓库。
2. 进入 **Settings** -> **Webhooks**。
3. 新建 webhook。
4. **Payload URL** 填：

```text
https://<你的 tunnel 域名>/github/webhooks
```

5. **Content type** 选择 `application/json`。
6. 填一个强随机 **Secret**，并保存下来给 OpenTag 使用。
7. 订阅这些事件：
   - **Issue comments**
   - **Pull request review comments**
8. 保存 webhook。

OpenTag 里对应这个字段：

```text
GitHub webhook secret
```

## GitHub Token

OpenTag 会用这个 token 把确认消息和最终结果回写到 GitHub。

如果你用 fine-grained personal access token，授权到目标仓库，并至少打开：

- **Issues**: Read and write
- **Pull requests**: Read and write
- **Contents**: Read and write，如果你希望 OpenTag 创建分支或 pull request

OpenTag 里对应这个字段：

```text
GitHub callback token
```

## 测试

setup 完成后启动 OpenTag：

```bash
opentag start
```

然后在 issue 或 pull request review thread 里评论：

```text
@opentag investigate this
```

OpenTag 应该会创建一次本地 run，执行完成后把结果回写到同一个 GitHub thread。
