# OpenTag CLI Quickstart HyperFrame

This is a short tutorial video source for the published OpenTag CLI. The story should present OpenTag as a source-thread-native governed agent work loop, not only as a connector from chat to a coding agent.

## Storyboard

1. Install the CLI.
2. Run `opentag setup`.
3. Choose the recommended background service option and verify it with `opentag service status`.
4. Mention OpenTag from Lark, Slack, or GitHub.
5. Show the source thread receiving a concise result with artifacts, an audit/status pointer, and a safe next action.
6. Approve important follow-up actions with `apply 1` only when the action receipt says it is ready.
7. Point viewers back to `npm install -g @opentag/cli@latest`, `opentag setup`, and `opentag service status`. Mention `opentag start` as the terminal-mode fallback.

The composition intentionally avoids deep architecture details. Its job is to teach the first usable loop while preserving the product boundary: OpenTag is not a new AI workspace; it keeps work in the existing source thread and detailed process in local audit/status.

## Preview

```bash
cd docs/hyperframes/opentag-cli-quickstart
npm run dev
```

## Check

```bash
cd docs/hyperframes/opentag-cli-quickstart
npm run check
```

## Render

```bash
cd docs/hyperframes/opentag-cli-quickstart
npm run render
```

The rendered video is generated under this HyperFrame project's render output directory.
