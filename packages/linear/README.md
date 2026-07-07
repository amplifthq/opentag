# @opentag/linear

Linear adapter utilities for OpenTag.

This package normalizes Linear issue-comment webhooks into `OpenTagEvent`s,
renders Linear-friendly source-thread replies, and applies approved Linear issue
mutations through the Linear GraphQL API.

It also contains the native Linear building blocks used by the CLI setup path:
OAuth app tokens and refresh helpers, workspace metadata discovery, reusable
status-comment updates, and Linear Agent session events/activities, including
Agent Session plan updates and follow-up `prompted` activity commands.
