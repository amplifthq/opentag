# GitHub Setup

Use this guide when `opentag setup` asks for GitHub settings.

The OpenTag CLI currently uses a **repository webhook** for GitHub. This is the smallest correct MVP path: GitHub sends issue and pull request comments to your local OpenTag process through a public tunnel, then OpenTag runs your local coding agent and posts the result back to GitHub.

GitHub App installation is the longer-term product path, but it is not the default CLI setup yet.

## Official Links

- [Creating repository webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Managing fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Create a fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)

## What OpenTag Handles

OpenTag setup helps with the parts that can be local and safe:

- It detects the GitHub repository from your local `origin` remote when possible.
- It generates a strong webhook secret.
- It saves the local dispatcher, GitHub webhook listener, runner, and repository binding.
- It starts the local webhook listener with `opentag start`.

## What You Still Need To Do

GitHub cannot call `localhost` on your computer. You still need:

- A public tunnel that forwards to the local OpenTag GitHub listener.
- A GitHub repository webhook that points to that public tunnel URL.
- A GitHub token that lets OpenTag post comments, and optionally create pull requests.

## 1. Run Setup

Run:

```bash
opentag setup
```

Choose:

```text
GitHub
```

OpenTag asks for:

```text
GitHub repository (owner/repo)
Allow OpenTag to create pull requests when runs change files?
GitHub token for comments and pull requests
```

OpenTag generates the webhook secret for you. You do not need to make one up.

## 2. Create The GitHub Token

OpenTag uses this token to post acknowledgement, progress, and final result comments.

1. Open [GitHub's token creation page](https://github.com/settings/personal-access-tokens/new).
2. Choose **Generate new token** if GitHub asks which token type to create.
3. Use a clear name, for example `OpenTag local agent`.
4. Under **Repository access**, choose **Only select repositories** and select the repository you entered in `opentag setup`.
5. Under **Repository permissions**, set:
   - **Issues**: Read and write
   - **Pull requests**: Read and write
6. If you allowed OpenTag to create pull requests when a coding agent changes files, also set:
   - **Contents**: Read and write
7. Click **Generate token**.
8. Copy the token immediately. GitHub only shows it once.
9. Paste it into the `GitHub token for comments and pull requests` prompt.

Do not grant webhook administration permission unless you specifically want a future workflow where OpenTag creates the webhook for you. The default setup does not need it.

## 3. Create A Public Tunnel

Start OpenTag:

```bash
opentag start
```

Then expose the GitHub listener with a tunnel, for example:

```bash
ngrok http 3000
```

OpenTag listens locally at:

```text
http://localhost:3000/github/webhooks
```

Your GitHub webhook payload URL should use the public tunnel host:

```text
https://<your-tunnel-host>/github/webhooks
```

## 4. Create The Repository Webhook

The official GitHub guide is [Creating repository webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks).

1. Open your repository on GitHub.
2. Go to **Settings** -> **Webhooks**.
3. Click **Add webhook**.
4. Set **Payload URL** to:

```text
https://<your-tunnel-host>/github/webhooks
```

5. Set **Content type** to `application/json`.
6. Paste the webhook **Secret** that `opentag setup` printed.
7. Subscribe to these events:
   - **Issue comments**
   - **Pull request review comments**
8. Save the webhook.

After saving, GitHub shows recent deliveries for this webhook. If OpenTag does not react later, this page is the first place to check whether GitHub sent the event.

## Test

After setup, `opentag start`, and webhook creation, comment on an issue or pull request review thread:

```text
@opentag investigate this
```

Expected result:

1. GitHub delivers the comment webhook to your tunnel.
2. OpenTag creates a run.
3. Your local runner executes the coding agent.
4. OpenTag posts acknowledgement, progress, and final result comments back to the same GitHub thread.

## If It Does Not Work

Check these first:

- The tunnel is running and points to port `3000`.
- The GitHub webhook Payload URL ends with `/github/webhooks`.
- The webhook content type is `application/json`.
- The webhook secret exactly matches the one saved by OpenTag.
- The webhook subscribes to **Issue comments** and **Pull request review comments**.
- The GitHub token has write access to Issues and Pull requests.
- `opentag start` is still running.
