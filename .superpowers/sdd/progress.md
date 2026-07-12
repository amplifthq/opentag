# ACP-First Agent Runtime SDD Progress

Plan: `docs/superpowers/plans/2026-07-12-acp-first-agent-runtime.md`

| Task | Implementation | Review | Commit |
| --- | --- | --- | --- |
| 1. Manifest and channel protocol | complete | approved | `326b40b8`, `d35b962c` |
| 2. Attempts and fencing | complete | approved | `57fa8f1b`, `d687be3e` |
| 3. Generic ACP host | complete | approved | `1c501014`, `bede02d3` |
| 4. Daemon and non-repo runs | complete | pending re-review | pending review |
| 5. Permissions and material actions | pending | pending | pending |
| 6. Channel UX and cleanup | pending | pending | pending |

## Review Notes

- Task 1 approved after stricter command validation and reuse of the canonical presentation seam.
- Task 2 approved after atomic lifecycle writes and stale-start failure-injection coverage.
- Task 3 approved after hardening cancellation, diagnostics, cwd containment, strict framing, and failure-delta retention.
- Task 4 implementation is complete pending independent review; named ACP agents, attempt-scoped scratch and repository workspaces, non-repository claims, and optional channel repository bindings are covered by focused tests.
- Task 4 review changes are addressed pending re-review: scratch security and early cleanup are workspace-aware, ACP PR preparation follows the canonical result intent and capability contract, and client/channel bindings carry repository targets only as an all-or-none group.
- Task 4 high re-review finding is addressed pending re-review: deterministic scratch attempt allocation now fails closed on any pre-existing path and preserves symlinks, files, directories, and their targets without invoking an executor.
