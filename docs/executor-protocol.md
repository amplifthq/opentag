# Removed custom executor protocol

The former `opentag.executor.v1` and `stdio-jsonl-basic` contracts have been
removed. They are not supported integration surfaces and no compatibility shim
is retained.

Agent integrations now use standard ACP v1 through a named `stdio` binding in
an `opentag.integration.v1` manifest. OpenTag remains the ACP client and owns the
durable Run, disposable Attempt, workspace envelope, permissions, approvals,
material Action receipts, presentation, and audit.

Use these documents instead:

- [ACP agent integration](./acp-agent-integration.md) for an implementer guide;
- [Integration taxonomy](./integration-taxonomy.md) for Agent and Channel roles;
- [ACP-first runtime design](./acp-first-agent-runtime-design.md) for the full
  architecture and security boundaries.
