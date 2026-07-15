# @opentag/linear

Linear adapter utilities for OpenTag.

This package normalizes Linear issue-comment webhooks into `OpenTagEvent`s,
renders Linear-friendly source-thread replies, and applies approved Linear issue
mutations through the Linear GraphQL API.

It also contains the native Linear building blocks used by the CLI setup path:
OAuth app tokens and refresh helpers, workspace metadata discovery, reusable
status-comment updates, and Linear Agent session events/activities, including
Agent Session plan updates and follow-up `prompted` activity commands.

## Backlog read contract

`@opentag/linear` exposes a channel-independent, read-only contract for
querying Linear issues and building bounded project backlog snapshots. Slack,
Lark, Teams, and other request sources should consume the same normalized
contract rather than depending on raw Linear GraphQL responses.

The contract includes:

- issue get, search, and list request types;
- team, project, and dynamic current-cycle scope;
- normalized issue, status, priority, label, assignee, and relation snapshots;
- explicit pagination limits and truncation state;
- requested versus resolved scope;
- capture time, contract version, and safe provenance metadata.

A `LinearBacklogSnapshot` is a point-in-time observation. Consumers must inspect
`truncated` and `pageInfo.hasNextPage` before treating it as a complete backlog.
Tokens, authorization headers, and connection secrets must never be included in
a snapshot.

The first read implementation exports `getLinearIssue` and
`searchLinearIssues`. Both use read-only GraphQL queries and return the same
normalized `LinearIssueSnapshot` shape. Search is currently team-scoped, caps
individual pages at 50 issues and one logical result at 100 issues, and reports
whether results were truncated. Project/current-cycle scope, relation loading, issue listing, and
backlog snapshot construction remain separate follow-up work.
