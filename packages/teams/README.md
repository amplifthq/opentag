# @opentag/teams

Microsoft Teams activity normalization and callback rendering for OpenTag.

Receives Bot Framework message activities that @mention the bot in a team
channel, normalizes them into an `OpenTagEvent`, and posts replies back to the
source channel thread via the Bot Connector REST API. Mounted into the
`local-runtime` dispatcher (no standalone events app).

Scope (v1): team channels only, plain-text/Markdown replies, @mention trigger.
