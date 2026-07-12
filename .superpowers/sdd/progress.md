# ACP-First Agent Runtime SDD Progress

Plan: `docs/superpowers/plans/2026-07-12-acp-first-agent-runtime.md`

| Task | Implementation | Review | Commit |
| --- | --- | --- | --- |
| 1. Manifest and channel protocol | complete | approved | `326b40b8`, `d35b962c` |
| 2. Attempts and fencing | complete | approved | `57fa8f1b`, `d687be3e` |
| 3. Generic ACP host | complete | approved | `1c501014`, `bede02d3` |
| 4. Daemon and non-repo runs | complete | approved | `ed90e7d0`, `718d6d4f`, `f727486f` |
| 5. Permissions and material actions | complete | approved | `e18dcbdc`, `659b2067`, `8c1ef9d9`, `2db42a5f`, `c8c27128` |
| 6. Channel UX and cleanup | complete | approved | `61077f95`, `d2af1a2c`, `6eb6fed2` |

## Review Notes

- Task 1 approved after stricter command validation and reuse of the canonical presentation seam.
- Task 2 approved after atomic lifecycle writes and stale-start failure-injection coverage.
- Task 3 approved after hardening cancellation, diagnostics, cwd containment, strict framing, and failure-delta retention.
- Task 4 approved after making scratch security and early cleanup workspace-aware, following result-declared PR branches, carrying repository targets as an all-or-none group, and failing closed on pre-existing scratch attempt paths.
- Task 5 approved after binding ACP action identity to credential-safe structured targets, making reusable grants explicit and transactionally fenced, rendering native Slack/Lark decisions, reconciling trusted receipts exactly once, and proving crash/approval/provider behavior end to end.
- Task 6 approved after authenticating managed channel ownership outside event metadata, failing closed on corrupt binding records, preserving one Slack Run Card across restarts, and sanitizing provider credentials plus every historical Attempt fence before durable or source-thread output.
