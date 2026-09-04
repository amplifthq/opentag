# Supported connections

OpenTag has one Source App and one repository provider in the supported profile:

| Role | Provider | Guide |
| --- | --- | --- |
| Persistent teammate presence, thread ingress, status, and approvals | Slack | [English](slack.en.md) / [简体中文](slack.zh-CN.md) |
| Project Target, approved draft-PR publication, and provider evidence | GitHub | [English](github.en.md) / [简体中文](github.zh-CN.md) |

Slack conversation state is a projection over canonical OpenTag Run and Attempt facts. GitHub provider observations are evidence; they do not independently own execution or completion state.
