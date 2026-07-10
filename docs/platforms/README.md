# Platform Setup Guides

OpenTag can listen to different work platforms and route each request to the same local coding-agent runtime.

Use these guides when `opentag setup` asks for platform credentials:

| Platform | Best first path | Guide |
| --- | --- | --- |
| Lark / Feishu | Scan the Personal Agent QR code from setup | [English](lark.en.md) / [简体中文](lark.zh-CN.md) |
| Slack | Use Socket Mode for local development | [English](slack.en.md) / [简体中文](slack.zh-CN.md) |
| GitHub | Use a repository webhook and GitHub token | [English](github.en.md) / [简体中文](github.zh-CN.md) |
| GitLab | Use a project Note Hook and GitLab access token | [English](gitlab.en.md) / [简体中文](gitlab.zh-CN.md) |
| Telegram | Use BotFather token with local getUpdates polling | [English](telegram.en.md) / [简体中文](telegram.zh-CN.md) |
| Discord | Use a bot token with local Gateway delivery | [English](discord.en.md) / [简体中文](discord.zh-CN.md) |
| Microsoft Teams | Use an Azure Bot and public HTTPS tunnel to the local dispatcher (relay mode is not supported) | [English](teams.en.md) / [简体中文](teams.zh-CN.md) |

Most guides only cover the values the OpenTag CLI asks for. Microsoft Teams has extra setup because Bot Framework requires a public HTTPS Messaging endpoint and a Teams app installed in a tenant. For deeper integration debugging, see [Real integration smoke test](../real-integration-smoke-test.md).
