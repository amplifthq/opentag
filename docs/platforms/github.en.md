# GitHub Project Target

## Supported profile

GitHub is OpenTag's only Project Target and publication/readback provider. It
is not a Source App. Slack supplies the source conversation; the self-hosted
Control Plane governs the Run; the paired Runner performs approved work against
the configured GitHub repository.

```text
Slack source thread
        |
        v
Control Plane -> Run -> Attempt -> paired Runner
                                      |
                         GitHub target / draft PR publication
                                      |
                           exact-head readback evidence
```

GitHub readback is evidence for completion gates. It does not own Run state,
Attempt leases, approval, cancellation, or terminal outcomes.

## Target configuration

Configure one explicit target in the paired Runner's repository bindings:

```text
provider: github
owner: acme
repo: demo
base branch: main
publication: governed draft pull request
```

The target identity is exact. A Run cannot publish to a repository, branch, or
pull request that is different from its current target and approved proposal.
Keep GitHub credentials in the Runner's protected credential store. Do not put
tokens in Slack messages, source events, ACP prompts, or durable presentation
payloads.

## Governed draft pull-request publication

The normal flow is:

1. The ACP Agent prepares changes in the Runner-owned workspace.
2. OpenTag records the changed files, branch, verification summary, and target
   as a proposal.
3. The source thread presents an action receipt with impact, preconditions,
   capability state, and approval requirement.
4. A human approves the exact current proposal.
5. The Control Plane checks Run/Attempt fencing, target identity, proposal hash,
   policy, and idempotency before provider I/O.
6. The Runner performs the GitHub publication and records a material-action
   receipt.
7. OpenTag reads back the exact head and required provider evidence before
   treating the publication as complete.

Approval is not publication. A local branch or generated patch is not a pull
request. A pull request URL is not proof that the expected head or checks are
current.

## Exact-head readback

Readback must identify the exact GitHub resource and revision under evaluation:

- repository `owner/repo`;
- pull-request number or other stable resource identity;
- head commit SHA;
- base branch or target ref;
- required-check conclusions and observation time;
- assurance level and source of each observation.

If the head changes after approval, the prior proposal is stale and must not be
silently published or marked complete. If GitHub accepts a request but the
result cannot be verified, retain `outcome_unknown` and reconcile before any
retry.

## Action receipts and failure states

GitHub publication is a material action with a stable idempotency key. The
receipt must distinguish at least:

- proposal prepared but not approved;
- approval recorded but provider I/O not attempted;
- publication succeeded and was read back at the exact expected head;
- publication rejected by policy, capability, or target mismatch;
- provider failure;
- provider result ambiguous: `outcome_unknown`.

Never report “merged”, “published”, or “checks passed” from a local process exit,
queued intent, stale cached page, or unverified provider response.

## What this guide does not cover

- GitHub as a Source App or conversation ingress;
- automatic branch push, merge, deployment, or release;
- unreviewed pull-request creation;
- multiple Project Targets in one governed publication;
- provider-specific credentials in Agent prompts;
- treating GitHub UI state as the canonical OpenTag lifecycle.

## Official links

- [GitHub REST API](https://docs.github.com/en/rest)
- [Pull requests REST API](https://docs.github.com/en/rest/pulls/pulls)
- [Checks API](https://docs.github.com/en/rest/checks/runs)
- [Fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [GitHub pull-request review](https://docs.github.com/en/pull-requests)

## Related OpenTag documents

- [Slack Source App](slack.en.md)
- [Source-thread action receipts](../source-thread-action-receipts.md)
- [Control Plane runtime architecture](../control-plane-runtime-architecture.md)
- [ACP agent integration](../acp-agent-integration.md)
