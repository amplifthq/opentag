# GitLab Setup

Use this guide when `opentag setup --platform gitlab` asks for GitLab values.

OpenTag turns GitLab issue and merge request notes into a governed local agent work loop: the source thread stays the human workflow surface, execution stays local, artifacts and action receipts come back concisely, and detailed evidence stays in audit/status.

## What You Need

- A GitLab project path, for example `acme/demo` or `acme/team/demo`.
- A GitLab personal access token or project access token with `api` scope so OpenTag can post issue / merge request notes and create merge requests after `apply 1`.
- A public tunnel URL that forwards GitLab webhooks to your local OpenTag process.
- For self-managed GitLab, the instance base URL, for example `https://gitlab.example.com`.

## Create The Token

For GitLab.com, open `https://gitlab.com/-/user_settings/personal_access_tokens`.

For self-managed GitLab, open:

```text
https://<your-gitlab-host>/-/user_settings/personal_access_tokens
```

Recommended token scope:

- `api`: required to create issue / merge request notes through the GitLab Notes API and create merge requests through the GitLab Merge Requests API after `apply 1`.

Keep the token private. OpenTag stores it in the local config file and redacts it in `opentag status` and `opentag doctor`.

## Run OpenTag Setup

For GitLab.com:

```bash
opentag setup \
  --platform gitlab \
  --gitlab-project acme/demo
```

For self-managed GitLab:

```bash
opentag setup \
  --platform gitlab \
  --gitlab-base-url https://gitlab.example.com \
  --gitlab-project acme/team/demo
```

The setup command saves:

- `platforms.gitlab.projectPathWithNamespace`
- `platforms.gitlab.baseUrl`
- `platforms.gitlab.token`
- `platforms.gitlab.webhookSecret`
- `platforms.gitlab.webhookPath`
- `platforms.gitlab.port`

It also binds the GitLab project target to the local checkout so GitLab issue and merge request mentions can route to the local runner.

## Configure The Project Webhook

Open the project webhook settings page:

```text
https://gitlab.com/<group>/<project>/-/hooks
```

For self-managed GitLab, replace `https://gitlab.com` with your configured base URL.

Set:

- URL: your public tunnel URL plus the OpenTag webhook path, for example `https://<your-tunnel-host>/gitlab/webhooks`.
- Secret token: the value printed by `opentag setup`.
- Trigger: enable `Note events`.
- SSL verification: enable it when your tunnel or hosted endpoint has a valid HTTPS certificate.

GitLab sends issue and merge request comments through Note Hook payloads. OpenTag listens for `@opentag` mentions, normalizes those payloads into the OpenTag event protocol, and replies through the GitLab Notes API.

## Start And Test

Start OpenTag:

```bash
opentag start
```

If you use a local tunnel, forward it to the GitLab webhook port printed by setup. The default is:

```bash
ngrok http 3060
```

Then comment on a GitLab issue or merge request:

```text
@opentag investigate this failing test
```

Expected behavior:

- OpenTag accepts the Note Hook delivery.
- The local runner starts against the bound checkout.
- OpenTag replies in the same GitLab issue or merge request thread.

While a run is active, you can inspect or stop the runtime from the same source thread:

```text
@opentag /status
@opentag /doctor
@opentag /stop [run_id]
```

These control commands report or cancel source-thread runtime state. They do not create another run.

## Relay Mode

GitLab relay mode is for a relay you operate or have confirmed is configured for GitLab. Do not point a GitLab project at a generic hosted relay unless the relay operator explicitly confirms that `/gitlab/webhooks` is enabled and has the matching GitLab secrets. Without that relay-side configuration, use local `opentag start` plus a public tunnel.

For a configured relay, point the GitLab project webhook at the relay URL plus the GitLab webhook path:

```text
https://<your-relay-host>/gitlab/webhooks
```

The self-hosted or custom relay must be configured with:

- `OPENTAG_GITLAB_WEBHOOK_SECRET`: the shared secret GitLab sends as `X-Gitlab-Token`.
- `OPENTAG_GITLAB_BASE_URL`: required for self-managed GitLab; optional for GitLab.com.
- `OPENTAG_GITLAB_TOKEN`: required for source-thread replies and direct merge request creation after `apply 1`.

`opentag pair --relay <url>` and `opentag start` print the GitLab relay webhook URL when the config includes GitLab. Treat that URL as actionable only after the relay has the GitLab environment variables above.

## Who Can Trigger Runs

By default, OpenTag decides who may start runs from the project itself:

- **Private and internal projects**: anyone who can comment may trigger runs.
- **Public projects**: closed by default. GitLab Note Hooks do not report the
  commenter's access level, so OpenTag cannot verify write access from the
  webhook alone. Configure `allowedActors` on the repository binding to allow
  specific GitLab usernames or user IDs to trigger runs and approve `apply`
  actions on a public project.

## Current Scope

Supported now:

- GitLab project setup in the CLI.
- Local `opentag start` GitLab webhook ingress.
- Self-hosted or custom relay GitLab webhook ingress at `/gitlab/webhooks` when the relay has the GitLab token and webhook secret configured.
- GitLab.com and self-managed GitLab through `--gitlab-base-url`.
- Issue note and merge request note mentions.
- Replying to the original issue or merge request via the Notes API.
- Updating the same GitLab status note during a run instead of creating a new progress note for every state.
- Direct GitLab merge request creation from supported `create_pull_request` action receipts after `apply 1`.
- Thread action commands such as `apply 1`, `approve 1`, `continue 1`, and `reject 1` when the dispatcher has a supported action receipt.
- Source-thread control commands such as `@opentag /status`, `@opentag /doctor`, and `@opentag /stop [run_id]` without creating a new run.

Not yet implemented:

- GitLab webhook auto-registration through the GitLab Project Webhooks API.

GitLab can create project webhooks through its API, but OpenTag does not auto-register them yet because the safe default setup still needs an operator-confirmed public URL and an explicit decision to grant webhook-management permission. Manual webhook creation keeps the required token scope narrower and matches the current GitHub setup boundary.
