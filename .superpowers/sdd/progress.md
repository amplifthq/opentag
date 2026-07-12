# ACP-First Agent Runtime SDD Progress

Plan: `docs/superpowers/plans/2026-07-12-acp-first-agent-runtime.md`

| Task | Implementation | Review | Commit |
| --- | --- | --- | --- |
| 1. Manifest and channel protocol | complete | approved | `326b40b8`, `d35b962c` |
| 2. Attempts and fencing | complete | approved | `57fa8f1b`, `d687be3e` |
| 3. Generic ACP host | complete | pending re-review | `1c501014` |
| 4. Daemon and non-repo runs | pending | pending | pending |
| 5. Permissions and material actions | pending | pending | pending |
| 6. Channel UX and cleanup | pending | pending | pending |

## Review Notes

- Task 1 approved after stricter command validation and reuse of the canonical presentation seam.
- Task 2 approved after atomic lifecycle writes and stale-start failure-injection coverage.
- Task 3 implementation fixes are pending re-review after hardening cancellation, diagnostics, cwd containment, strict framing, and failure-delta retention.
