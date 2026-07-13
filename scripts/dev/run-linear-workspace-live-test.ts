import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenTagClient } from "../../packages/client/src/index.js";
import { createDispatcherApp } from "../../packages/dispatcher/src/server.js";
import { createLinearAdapterMappingDrafts, discoverLinearMetadata } from "../../packages/linear/src/discovery.js";
import { computeLinearSignature } from "../../packages/linear/src/ingress.js";
import { linearGraphql } from "../../packages/linear/src/graphql.js";
import { fetchLinearWorkspaceIdentity } from "../../packages/linear/src/oauth.js";

type LinearIssueInfo = {
  id: string;
  identifier: string;
  title?: string | null;
  url: string;
  priority?: number | null;
  team: {
    id: string;
    key?: string | null;
    name?: string | null;
  };
};

type CallbackProbe = {
  kind: string;
  hasStatusMessageKey: boolean;
  externalMessageId?: string;
  hasExternalMessageId: boolean;
  returnedExternalMessageId?: boolean;
  error?: string;
};

type JsonObject = Record<string, unknown>;
type AgentSessionSmokeResult = {
  runId: string;
  callbackLog: SanitizedCallbackProbe[];
  metrics: {
    humanCallbackCount: number;
  };
  prompted: {
    queuedFollowUpId: string;
    queuedBehindRunId: string;
    followUpStatus: "promoted";
    promotedFromQueuedFollowUp: boolean;
    runId: string;
    callbackLog: SanitizedCallbackProbe[];
    metrics: {
      humanCallbackCount: number;
    };
  };
};
type SanitizedCallbackProbe = Omit<CallbackProbe, "externalMessageId">;
type LinearGraphqlEvidenceJson = {
  requestCount: number;
  operationCounts: Record<string, number>;
  commentUpdateIds: string[];
  requiredOperations: Record<string, boolean>;
};
type MetadataDiscoverySmokeResult = {
  teams: number;
  users: number;
  workflowStates: number;
  issueLabels: number;
  issueTeamDiscovered: boolean;
  mappingDomains: string[];
  mappingValueCounts: Record<string, number>;
};
type LinearActorSmokeResult = {
  viewerId?: string;
  viewerIsApp?: boolean;
  organizationId?: string;
  appActorVerified: boolean;
  compatibilityMode: boolean;
  warning?: string;
};
type SingleStatusCommentProbe = {
  statusCallbackCount: number;
  updateCount: number;
  reusedExternalMessageId: boolean;
  externalMessageId?: string;
};
type SingleStatusCommentGraphqlProbe = {
  commentCreateCount: number;
  commentUpdateCount: number;
  statusCommentUpdateCount: number;
  statusCommentUpdateVerified: boolean;
};

const linearGraphqlEvidenceOperations = [
  "OpenTagLinearLiveSmokeIssue",
  "OpenTagLinearWorkspaceIdentity",
  "OpenTagLinearMetadataTeams",
  "OpenTagLinearMetadataUsers",
  "OpenTagLinearMetadataWorkflowStates",
  "OpenTagLinearMetadataIssueLabels",
  "commentCreate",
  "commentUpdate",
  "issueUpdate",
  "agentSessionUpdate",
  "agentActivityCreate"
] as const;

const timestamp = Date.now();
const token = requiredEnv("OPENTAG_LINEAR_SMOKE_TOKEN");
const issueRef = requiredLinearIssueRef();
const webhookSecret = optionalEnv("OPENTAG_LINEAR_SMOKE_WEBHOOK_SECRET") ?? `linear_smoke_whsec_${randomBytes(24).toString("hex")}`;
const oauthWebhookSecret = optionalEnv("OPENTAG_LINEAR_SMOKE_OAUTH_WEBHOOK_SECRET") ?? `linear_smoke_oauth_whsec_${randomBytes(24).toString("hex")}`;
const oauthWebhookPath = optionalEnv("OPENTAG_LINEAR_SMOKE_OAUTH_WEBHOOK_PATH") ?? "/linear/oauth/webhooks";
const graphqlUrl = optionalEnv("OPENTAG_LINEAR_SMOKE_GRAPHQL_URL");
const agentSessionId = optionalEnv("OPENTAG_LINEAR_SMOKE_AGENT_SESSION_ID");
const metadataDiscoveryLimit = parsePositiveIntegerEnv("OPENTAG_LINEAR_SMOKE_DISCOVERY_LIMIT") ?? 100;
const allowNonAppToken = parseBooleanEnv("OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN") ?? false;
const owner = optionalEnv("OPENTAG_LINEAR_SMOKE_REPO_OWNER") ?? "linear-live-smoke";
const repo = optionalEnv("OPENTAG_LINEAR_SMOKE_REPO_NAME") ?? "workspace";
const provider = optionalEnv("OPENTAG_LINEAR_SMOKE_REPO_PROVIDER") ?? "github";
const runnerId = `linear-live-${timestamp.toString(36)}`;
const relayInstallationId = `install_linear_live_${timestamp.toString(36)}`;
const relayWebhookPath = `/linear/webhooks/${relayInstallationId}`;

const tempDir = await mkdtemp(join(tmpdir(), "opentag-linear-live-smoke-"));
const databasePath = join(tempDir, "opentag-linear-live-smoke.db");
const linearGraphqlEvidence = createLinearGraphqlEvidenceRecorder({ graphqlUrl });
const originalFetch = globalThis.fetch;
const boundFetch = originalFetch.bind(globalThis) as typeof fetch;
globalThis.fetch = (async (input, init) => {
  linearGraphqlEvidence.record(input, init);
  return boundFetch(input, init);
}) as typeof fetch;

try {
  const issue = await fetchLinearIssue({ token, issueRef, ...(graphqlUrl ? { graphqlUrl } : {}) });
  const workspaceIdentity = await fetchLinearWorkspaceIdentity({ token, ...(graphqlUrl ? { graphqlUrl } : {}) }).catch((error: unknown) => {
    if (allowNonAppToken) return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Linear workspace identity is required to verify OAuth app actor smoke tokens: ${detail}`);
  });
  const oauthActor = verifyLinearSmokeActor({ workspaceIdentity, allowNonAppToken });
  const metadataDiscovery = await runMetadataDiscoverySmoke({
    token,
    issue,
    first: metadataDiscoveryLimit,
    ...(graphqlUrl ? { graphqlUrl } : {})
  });
  const organizationId = optionalEnv("OPENTAG_LINEAR_SMOKE_ORGANIZATION_ID") ?? workspaceIdentity.organization?.id ?? "linear_live_smoke";
  const app = createDispatcherApp({
    databasePath,
    linearOAuthInstall: {
      clientId: "linear_live_smoke_client",
      redirectUri: "https://opentag-linear-live-smoke.local/linear/oauth/callback",
      webhookSecret: oauthWebhookSecret,
      webhookPath: oauthWebhookPath
    }
  });
  const client = createOpenTagClient({
    dispatcherUrl: "http://opentag-linear-live-smoke.local",
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    }
  });

  await client.registerRunner({ runnerId, name: "Linear Live Smoke Runner" });
  await client.bindRepository({
    provider,
    owner,
    repo,
    runnerId,
    workspacePath: tempDir,
    defaultExecutor: "echo",
    allowedActors: ["linear_smoke_user"]
  });
  const relayInstall = await client.upsertLinearRelayInstallation({
    id: relayInstallationId,
    webhookPath: relayWebhookPath,
    webhookSecret,
    token,
    ...(graphqlUrl ? { graphqlUrl } : {}),
    repoProvider: provider,
    owner,
    repo,
    organizationId,
    ...(issue.team.id ? { teamId: issue.team.id } : {}),
    ...(issue.team.key ? { teamKey: issue.team.key } : {})
  });
  assert(relayInstall.installation.webhookPath === relayWebhookPath, "relay installation should return the dynamic Linear webhook path");

  const createWebhookResponse = await app.request(
    oauthWebhookPath,
    signedLinearWebhookRequest(
      {
        type: "Comment",
        action: "create",
        webhookId: `linear_live_webhook_${timestamp}`,
        organizationId,
        createdAt: new Date().toISOString(),
        webhookTimestamp: Date.now(),
        data: {
          id: `comment_linear_live_${Date.now()}`,
          body: "@opentag run Linear live workspace smoke",
          url: `${issue.url}#comment-opentag-live-smoke-source`,
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title ?? "Linear live smoke issue",
            url: issue.url,
            team: issue.team
          },
          user: {
            id: "linear_smoke_user",
            name: "Linear Smoke User",
            displayName: "Linear Smoke"
          }
        }
      },
      oauthWebhookSecret
    )
  );
  assert(createWebhookResponse.status === 200, `Linear create webhook returned ${createWebhookResponse.status}`);
  const createWebhookBody = (await createWebhookResponse.json()) as JsonObject;
  const runId = typeof createWebhookBody.runId === "string" ? createWebhookBody.runId : undefined;
  assert(runId, "Linear webhook should return the created run id");

  const claimed = await client.claim({ runnerId });
  assert(claimed?.run.id === runId, "runner should claim the Linear webhook-created run");

  await client.complete({
    runnerId,
    runId,
    attemptId: claimed.attemptId,
    fencingToken: claimed.fencingToken,
    result: {
      conclusion: "needs_human",
      summary: "Prepared a Linear live smoke issue update.",
      suggestedChanges: [
        {
          proposalId: "proposal_linear_live_smoke",
          createdAt: new Date().toISOString(),
          summary: "Re-apply the current Linear issue priority as a safe no-op mutation.",
          intents: [
            {
              intentId: "intent_linear_live_priority",
              domain: "priority",
              action: "set_priority",
              summary: `Set Linear issue priority to ${issue.priority ?? 0}.`,
              params: { priority: issue.priority ?? 0 }
            }
          ]
        }
      ],
      verification: [{ command: "Linear webhook -> run", outcome: "passed" }]
    }
  });

  const applyWebhookResponse = await app.request(
    oauthWebhookPath,
    signedLinearWebhookRequest(
      {
        type: "Comment",
        action: "create",
        webhookId: `linear_live_apply_${timestamp}`,
        organizationId,
        createdAt: new Date().toISOString(),
        webhookTimestamp: Date.now(),
        data: {
          id: `comment_linear_live_apply_${Date.now()}`,
          body: "apply 1",
          url: `${issue.url}#comment-opentag-live-smoke-apply`,
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title ?? "Linear live smoke issue",
            url: issue.url,
            team: issue.team
          },
          user: {
            id: "linear_smoke_user",
            name: "Linear Smoke User",
            displayName: "Linear Smoke"
          }
        }
      },
      oauthWebhookSecret
    )
  );
  assert(applyWebhookResponse.status === 200, `Linear apply webhook returned ${applyWebhookResponse.status}`);
  const applyWebhookBody = (await applyWebhookResponse.json()) as JsonObject;
  assert(applyWebhookBody.action === "apply", "Linear apply webhook should submit an apply thread action");

  const proposal = await client.getProposal({ proposalId: "proposal_linear_live_smoke" });
  assert(proposal.runId === runId, "proposal should point to the Linear webhook-created run");
  const runRecord = await client.getRun({ runId });
  assert(runRecord.event.metadata["linearRelayInstallationId"] === relayInstallationId, "run should retain the dynamic Linear relay installation id");
  const callbackLog = callbackProbesFromEvents((await client.listRunEvents({ runId })).events);
  const singleStatusComment = singleStatusCommentProbe(callbackLog);
  const metrics = await client.getRunMetrics({ runId });
  assert(metrics.metrics.applyOutcomeCounts.applied === 1, "Linear issueUpdate should apply exactly once");
  assert(callbackLog.some((entry) => entry.kind === "acknowledgement" && entry.returnedExternalMessageId), "acknowledgement should create a real Linear comment");
  assert(callbackLog.some((entry) => entry.kind === "final" && entry.hasExternalMessageId), "final should reuse the Linear status comment id");
  assert(singleStatusComment.reusedExternalMessageId, "status callbacks should reuse a single Linear comment id");
  assert(singleStatusComment.updateCount >= 1, "status callbacks should update the existing Linear status comment at least once");
  const agentSessionSmoke = agentSessionId
    ? await runAgentSessionSmoke({
        app,
        client,
        issue,
        agentSessionId,
        relayInstallationId,
        relayWebhookPath: oauthWebhookPath,
        webhookSecret: oauthWebhookSecret,
        organizationId,
        runnerId
      })
    : undefined;
  assertLinearGraphqlEvidence(linearGraphqlEvidence, { includeAgentSession: Boolean(agentSessionSmoke) });
  const linearGraphqlEvidenceJson = linearGraphqlEvidence.toJSON({ includeAgentSession: Boolean(agentSessionSmoke) });
  const singleStatusCommentGraphql = singleStatusCommentGraphqlProbe({ evidence: linearGraphqlEvidenceJson, singleStatusComment });
  assert(
    singleStatusCommentGraphql.statusCommentUpdateVerified,
    `Linear status comment updates should target the reused status comment id; saw statusCommentUpdateCount=${singleStatusCommentGraphql.statusCommentUpdateCount}, expected at least ${singleStatusComment.updateCount}.`
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        relayInstallation: {
          id: relayInstallationId,
          webhookPath: relayWebhookPath
        },
        hostedOAuthWebhook: {
          path: oauthWebhookPath,
          organizationId: redactId(organizationId)
        },
        oauthActor,
        issue: {
          id: redactId(issue.id),
          identifier: issue.identifier,
          url: issue.url
        },
        metadataDiscovery,
        callbackLog: callbackLog.map(sanitizeCallbackProbe),
        singleStatusComment: {
          statusCallbackCount: singleStatusComment.statusCallbackCount,
          updateCount: singleStatusComment.updateCount,
          reusedExternalMessageId: singleStatusComment.reusedExternalMessageId,
          graphql: singleStatusCommentGraphql
        },
        ...(agentSessionSmoke ? { agentSessionSmoke } : {}),
        linearGraphqlEvidence: linearGraphqlEvidenceJson,
        metrics: {
          humanCallbackCount: metrics.metrics.humanCallbackCount,
          applyOutcomeCounts: metrics.metrics.applyOutcomeCounts
        }
      },
      null,
      2
    )
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
}

async function runAgentSessionSmoke(input: {
  app: ReturnType<typeof createDispatcherApp>;
  client: ReturnType<typeof createOpenTagClient>;
  issue: LinearIssueInfo;
  agentSessionId: string;
  relayInstallationId: string;
  relayWebhookPath: string;
  webhookSecret: string;
  organizationId: string;
  runnerId: string;
}): Promise<AgentSessionSmokeResult> {
  const createdResponse = await input.app.request(
    input.relayWebhookPath,
    signedLinearWebhookRequest(
      {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: `linear_live_agent_session_${timestamp}`,
        organizationId: input.organizationId,
        createdAt: new Date().toISOString(),
        webhookTimestamp: Date.now(),
        promptContext: "Run the OpenTag Linear live workspace smoke through the native agent session path.",
        agentSession: {
          id: input.agentSessionId,
          creator: {
            id: "linear_smoke_user",
            name: "Linear Smoke User"
          },
          issue: {
            id: input.issue.id,
            identifier: input.issue.identifier,
            title: input.issue.title ?? "Linear live smoke issue",
            url: input.issue.url,
            team: input.issue.team
          }
        }
      },
      input.webhookSecret
    )
  );
  assert(createdResponse.status === 200, `Linear AgentSessionEvent webhook returned ${createdResponse.status}`);
  const createdBody = (await createdResponse.json()) as JsonObject;
  const createdRunId = typeof createdBody.runId === "string" ? createdBody.runId : undefined;
  assert(createdRunId, "Linear AgentSessionEvent webhook should return the created run id");

  const claimed = await input.client.claim({ runnerId: input.runnerId });
  assert(claimed?.run.id === createdRunId, "runner should claim the Linear AgentSessionEvent-created run");
  await input.client.markRunning({
    runnerId: input.runnerId,
    runId: createdRunId,
    attemptId: claimed.attemptId,
    fencingToken: claimed.fencingToken,
    executor: "linear-live-smoke"
  });

  const promptedCommand = "Run the OpenTag Linear live workspace smoke follow-up prompt path.";
  const promptedResponse = await input.app.request(
    input.relayWebhookPath,
    signedLinearWebhookRequest(
      {
        type: "AgentSessionEvent",
        action: "prompted",
        webhookId: `linear_live_agent_session_prompted_${timestamp}`,
        organizationId: input.organizationId,
        createdAt: new Date().toISOString(),
        webhookTimestamp: Date.now(),
        promptContext: "This context should not override the prompted activity body.",
        agentActivity: {
          id: `agent_activity_prompt_${timestamp}`,
          body: promptedCommand
        },
        agentSession: {
          id: input.agentSessionId,
          creator: {
            id: "linear_smoke_user",
            name: "Linear Smoke User"
          },
          issue: {
            id: input.issue.id,
            identifier: input.issue.identifier,
            title: input.issue.title ?? "Linear live smoke issue",
            url: input.issue.url,
            team: input.issue.team
          }
        }
      },
      input.webhookSecret
    )
  );
  assert(promptedResponse.status === 200, `Linear AgentSessionEvent prompted webhook returned ${promptedResponse.status}`);
  const promptedBody = (await promptedResponse.json()) as JsonObject;
  assert(promptedBody.ok === true, "Linear AgentSessionEvent prompted webhook should acknowledge queued follow-up work");
  assert(!("runId" in promptedBody), "Linear AgentSessionEvent prompted webhook should not create a concurrent run while the session run is active");

  const queuedFollowUp = await assertAgentSessionQueuedFollowUp({
    app: input.app,
    activeRunId: createdRunId,
    agentSessionId: input.agentSessionId,
    organizationId: input.organizationId,
    issue: input.issue,
    relayInstallationId: input.relayInstallationId,
    graphqlUrl: optionalEnv("OPENTAG_LINEAR_SMOKE_GRAPHQL_URL"),
    command: promptedCommand
  });

  await input.client.complete({
    runnerId: input.runnerId,
    runId: createdRunId,
    attemptId: claimed.attemptId,
    fencingToken: claimed.fencingToken,
    result: {
      conclusion: "success",
      summary: "Completed the Linear native agent session smoke.",
      verification: [{ command: "Linear AgentSessionEvent -> AgentActivity", outcome: "passed" }]
    }
  });

  const callbackLog = callbackProbesFromEvents((await input.client.listRunEvents({ runId: createdRunId })).events);
  const metrics = await input.client.getRunMetrics({ runId: createdRunId });
  assert(callbackLog.some((entry) => entry.kind === "acknowledgement" && entry.hasExternalMessageId), "agent created acknowledgement should create a Linear Agent Activity");
  assert(callbackLog.some((entry) => entry.kind === "final" && entry.hasExternalMessageId), "agent created final callback should create a Linear Agent Activity");

  const promptedClaimed = await input.client.claim({ runnerId: input.runnerId });
  assert(promptedClaimed, "runner should claim the promoted Linear AgentSessionEvent-prompted follow-up run");
  const promptedRunId = promptedClaimed.run.id;
  const promotedFollowUp = (await input.client.getFollowUpRequest({ id: queuedFollowUp.id })).followUpRequest;
  assert(promotedFollowUp.status === "promoted", "Linear AgentSessionEvent prompted follow-up should be promoted after the active run completes");
  assert(promotedFollowUp.createdRunId === promptedRunId, "Linear AgentSessionEvent prompted follow-up should promote into the claimed run");
  assert(promotedFollowUp.activeRunId === createdRunId, "Linear AgentSessionEvent prompted follow-up should retain the active parent run id");
  assert(
    promptedClaimed.event.command.rawText === promptedCommand,
    "Linear AgentSessionEvent prompted run should use the agent activity body as the command"
  );

  await input.client.complete({
    runnerId: input.runnerId,
    runId: promptedRunId,
    attemptId: promptedClaimed.attemptId,
    fencingToken: promptedClaimed.fencingToken,
    result: {
      conclusion: "success",
      summary: "Completed the Linear native agent session prompted smoke.",
      verification: [{ command: "Linear AgentSessionEvent prompted -> AgentActivity", outcome: "passed" }]
    }
  });

  const promptedCallbackLog = callbackProbesFromEvents((await input.client.listRunEvents({ runId: promptedRunId })).events);
  const promptedMetrics = await input.client.getRunMetrics({ runId: promptedRunId });
  assert(
    promptedCallbackLog.some((entry) => entry.kind === "acknowledgement" && entry.hasExternalMessageId),
    "agent prompted acknowledgement should create a Linear Agent Activity"
  );
  assert(
    promptedCallbackLog.some((entry) => entry.kind === "final" && entry.hasExternalMessageId),
    "agent prompted final callback should create a Linear Agent Activity"
  );

  return {
    runId: createdRunId,
    callbackLog: callbackLog.map(sanitizeCallbackProbe),
    metrics: {
      humanCallbackCount: metrics.metrics.humanCallbackCount
    },
    prompted: {
      queuedFollowUpId: queuedFollowUp.id,
      queuedBehindRunId: createdRunId,
      followUpStatus: "promoted",
      promotedFromQueuedFollowUp: promotedFollowUp.createdRunId === promptedRunId,
      runId: promptedRunId,
      callbackLog: promptedCallbackLog.map(sanitizeCallbackProbe),
      metrics: {
        humanCallbackCount: promptedMetrics.metrics.humanCallbackCount
      }
    }
  };
}

async function assertAgentSessionQueuedFollowUp(input: {
  app: ReturnType<typeof createDispatcherApp>;
  activeRunId: string;
  agentSessionId: string;
  organizationId: string;
  issue: LinearIssueInfo;
  relayInstallationId: string;
  graphqlUrl?: string;
  command: string;
}): Promise<{ id: string }> {
  const statusResponse = await input.app.request(
    "/v1/thread-actions",
    jsonRequest({
      rawText: "/status",
      actor: {
        provider: "linear",
        providerUserId: "linear_smoke_user",
        handle: "Linear Smoke User",
        organizationId: input.organizationId
      },
      callback: {
        provider: "linear",
        uri: `linear://agent-session/${input.agentSessionId}/activities`,
        threadKey: `${input.issue.team.key ?? input.issue.team.id}|issue|${input.issue.identifier}`
      },
      metadata: {
        repoProvider: provider,
        owner,
        repo,
        agentSessionId: input.agentSessionId,
        linearRelayInstallationId: input.relayInstallationId,
        ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {})
      }
    })
  );
  assert(statusResponse.status === 200, `Linear AgentSessionEvent /status returned ${statusResponse.status}`);
  const statusBody = (await statusResponse.json()) as JsonObject;
  const activeRun = isRecord(statusBody.activeRun) ? statusBody.activeRun : undefined;
  assert(activeRun?.id === input.activeRunId, "Linear AgentSessionEvent /status should report the active run id");
  assert(activeRun.status === "running", "Linear AgentSessionEvent /status should report the active run as running");

  const queuedFollowUps = Array.isArray(statusBody.queuedFollowUps) ? statusBody.queuedFollowUps : [];
  const queuedFollowUp = queuedFollowUps.find((candidate) => {
    if (!isRecord(candidate)) return false;
    const event = isRecord(candidate.event) ? candidate.event : {};
    const command = isRecord(event.command) ? event.command : {};
    return candidate.activeRunId === input.activeRunId && command.rawText === input.command;
  });
  assert(isRecord(queuedFollowUp), "Linear AgentSessionEvent /status should show the prompted activity as a queued follow-up");
  assert(queuedFollowUp.status === "queued", "Linear AgentSessionEvent prompted follow-up should remain queued before the active run completes");
  const id = typeof queuedFollowUp.id === "string" ? queuedFollowUp.id : undefined;
  assert(id, "Linear AgentSessionEvent queued follow-up should have an id");
  return { id };
}

async function runMetadataDiscoverySmoke(input: {
  token: string;
  issue: LinearIssueInfo;
  graphqlUrl?: string;
  first: number;
}): Promise<MetadataDiscoverySmokeResult> {
  const snapshot = await discoverLinearMetadata({
    token: input.token,
    first: input.first,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {})
  });
  const mappingDrafts = createLinearAdapterMappingDrafts(snapshot);
  const mappingDomains = mappingDrafts.map((draft) => draft.domain).sort();
  const mappingValueCounts = Object.fromEntries(
    mappingDrafts.map((draft) => [draft.domain, Object.keys(draft.values).length])
  );
  const issueTeamDiscovered = snapshot.teams.some((team) => {
    return team.id === input.issue.team.id || (Boolean(input.issue.team.key) && team.key === input.issue.team.key);
  });

  assert(snapshot.teams.length > 0, "Linear metadata discovery should return at least one team");
  assert(snapshot.workflowStates.length > 0, "Linear metadata discovery should return workflow states");
  assert(issueTeamDiscovered, "Linear metadata discovery should include the smoke issue team");
  for (const domain of ["assignee", "label", "priority", "status", "team"]) {
    assert(mappingDomains.includes(domain), `Linear metadata discovery should generate a ${domain} mapping draft`);
  }
  assert((mappingValueCounts.status ?? 0) > 0, "Linear metadata discovery should generate status mapping values");
  assert((mappingValueCounts.priority ?? 0) > 0, "Linear metadata discovery should generate priority mapping values");
  assert((mappingValueCounts.team ?? 0) > 0, "Linear metadata discovery should generate team mapping values");

  return {
    teams: snapshot.teams.length,
    users: snapshot.users.length,
    workflowStates: snapshot.workflowStates.length,
    issueLabels: snapshot.issueLabels.length,
    issueTeamDiscovered,
    mappingDomains,
    mappingValueCounts
  };
}

function verifyLinearSmokeActor(input: {
  workspaceIdentity?: Awaited<ReturnType<typeof fetchLinearWorkspaceIdentity>>;
  allowNonAppToken: boolean;
}): LinearActorSmokeResult {
  const viewerIsApp = input.workspaceIdentity?.viewer.app;
  if (viewerIsApp !== true && !input.allowNonAppToken) {
    const actual = viewerIsApp === undefined ? "unknown" : String(viewerIsApp);
    throw new Error(
      `Linear live smoke token must belong to an OAuth app actor by default; viewer.app was ${actual}. Set OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN=true only for API-key compatibility smoke runs.`
    );
  }

  return {
    ...(input.workspaceIdentity?.viewer.id ? { viewerId: redactId(input.workspaceIdentity.viewer.id) } : {}),
    ...(viewerIsApp !== undefined ? { viewerIsApp } : {}),
    ...(input.workspaceIdentity?.organization?.id ? { organizationId: redactId(input.workspaceIdentity.organization.id) } : {}),
    appActorVerified: viewerIsApp === true,
    compatibilityMode: input.allowNonAppToken,
    ...(viewerIsApp !== true
      ? { warning: "Non-app Linear token accepted only because OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN=true." }
      : {})
  };
}

async function fetchLinearIssue(input: {
  token: string;
  issueRef: string;
  graphqlUrl?: string;
}): Promise<LinearIssueInfo> {
  const data = await linearGraphql<{
    issue?: LinearIssueInfo | null;
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: fetch,
    query: `query OpenTagLinearLiveSmokeIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    url
    priority
    team { id key name }
  }
}`,
    variables: { id: input.issueRef }
  });
  if (!data.issue?.id || !data.issue.identifier || !data.issue.url || !data.issue.team?.id) {
    throw new Error("Linear smoke issue query returned an incomplete issue.");
  }
  return data.issue;
}

function createLinearGraphqlEvidenceRecorder(input: { graphqlUrl?: string }): {
  record: (requestInput: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => void;
  has: (operation: string) => boolean;
  toJSON: (options: { includeAgentSession: boolean }) => LinearGraphqlEvidenceJson;
} {
  const expectedUrl = new URL(input.graphqlUrl ?? "https://api.linear.app/graphql");
  const operationCounts = new Map<string, number>();
  const commentUpdateIds: string[] = [];
  let requestCount = 0;

  return {
    record(requestInput, init) {
      const requestUrl = fetchRequestUrl(requestInput);
      if (!requestUrl || !isSameGraphqlEndpoint(requestUrl, expectedUrl)) return;

      const parsedBody = graphqlRequestBody(init?.body);
      const query = parsedBody?.query;
      if (!query) return;

      requestCount += 1;
      for (const operation of graphqlEvidenceOperations(query)) {
        operationCounts.set(operation, (operationCounts.get(operation) ?? 0) + 1);
      }
      if (query.includes("commentUpdate")) {
        const commentUpdateId = graphqlVariableString(parsedBody?.variables, "id");
        if (commentUpdateId) commentUpdateIds.push(commentUpdateId);
      }
    },
    has(operation) {
      return (operationCounts.get(operation) ?? 0) > 0;
    },
    toJSON(options) {
      const requiredOperations: Record<string, boolean> = {
        issueLookup: (operationCounts.get("OpenTagLinearLiveSmokeIssue") ?? 0) > 0,
        workspaceIdentity: (operationCounts.get("OpenTagLinearWorkspaceIdentity") ?? 0) > 0,
        metadataTeams: (operationCounts.get("OpenTagLinearMetadataTeams") ?? 0) > 0,
        metadataUsers: (operationCounts.get("OpenTagLinearMetadataUsers") ?? 0) > 0,
        metadataWorkflowStates: (operationCounts.get("OpenTagLinearMetadataWorkflowStates") ?? 0) > 0,
        metadataIssueLabels: (operationCounts.get("OpenTagLinearMetadataIssueLabels") ?? 0) > 0,
        commentCreate: (operationCounts.get("commentCreate") ?? 0) > 0,
        commentUpdate: (operationCounts.get("commentUpdate") ?? 0) > 0,
        issueUpdate: (operationCounts.get("issueUpdate") ?? 0) > 0
      };
      if (options.includeAgentSession) {
        requiredOperations.agentSessionUpdate = (operationCounts.get("agentSessionUpdate") ?? 0) > 0;
        requiredOperations.agentActivityCreate = (operationCounts.get("agentActivityCreate") ?? 0) > 0;
      }
      return {
        requestCount,
        operationCounts: Object.fromEntries([...operationCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
        commentUpdateIds,
        requiredOperations
      };
    }
  };
}

function assertLinearGraphqlEvidence(
  recorder: ReturnType<typeof createLinearGraphqlEvidenceRecorder>,
  options: { includeAgentSession: boolean }
): void {
  const required = [
    "OpenTagLinearLiveSmokeIssue",
    "OpenTagLinearWorkspaceIdentity",
    "OpenTagLinearMetadataTeams",
    "OpenTagLinearMetadataUsers",
    "OpenTagLinearMetadataWorkflowStates",
    "OpenTagLinearMetadataIssueLabels",
    "commentCreate",
    "commentUpdate",
    "issueUpdate"
  ];
  if (options.includeAgentSession) {
    required.push("agentSessionUpdate", "agentActivityCreate");
  }
  for (const operation of required) {
    assert(recorder.has(operation), `Linear GraphQL evidence is missing ${operation}.`);
  }
}

function graphqlEvidenceOperations(query: string): string[] {
  const operations = new Set<string>();
  const operationName = query.match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/u)?.[1];
  if (operationName) operations.add(operationName);
  for (const operation of linearGraphqlEvidenceOperations) {
    if (query.includes(operation)) operations.add(operation);
  }
  return [...operations];
}

function graphqlRequestBody(body: RequestInit["body"]): { query?: string; variables?: unknown } | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      ...(typeof parsed.query === "string" ? { query: parsed.query } : {}),
      ...(parsed.variables !== undefined ? { variables: parsed.variables } : {})
    };
  } catch {
    return undefined;
  }
}

function graphqlVariableString(variables: unknown, key: string): string | undefined {
  if (!isRecord(variables)) return undefined;
  const value = variables[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fetchRequestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return undefined;
}

function isSameGraphqlEndpoint(rawUrl: string, expectedUrl: URL): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === expectedUrl.origin && parsed.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

function signedLinearWebhookRequest(payload: JsonObject, secret: string): RequestInit {
  const rawBody = JSON.stringify(payload);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": computeLinearSignature({ webhookSecret: secret, rawBody }),
      "linear-timestamp": String(payload.webhookTimestamp ?? Date.now())
    },
    body: rawBody
  };
}

function jsonRequest(body: JsonObject): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Linear live smoke test.`);
  return value;
}

function requiredLinearIssueRef(): string {
  const raw = optionalEnv("OPENTAG_LINEAR_SMOKE_ISSUE") ?? optionalEnv("OPENTAG_LINEAR_SMOKE_ISSUE_ID");
  if (!raw) {
    throw new Error("Missing required env OPENTAG_LINEAR_SMOKE_ISSUE or OPENTAG_LINEAR_SMOKE_ISSUE_ID.");
  }
  return normalizeLinearIssueRef(raw);
}

function normalizeLinearIssueRef(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Linear smoke issue reference must not be empty.");
  }

  const pathMatch = trimmed.match(/\/issue\/([^/#?]+)/u);
  if (pathMatch?.[1]) {
    return decodeURIComponent(pathMatch[1]);
  }

  try {
    const parsed = new URL(trimmed);
    const issueIndex = parsed.pathname.split("/").findIndex((segment) => segment === "issue");
    const issueRef = issueIndex >= 0 ? parsed.pathname.split("/")[issueIndex + 1] : undefined;
    if (issueRef) return decodeURIComponent(issueRef);
  } catch {
    // Non-URL values can be Linear identifiers like ENG-123 or model UUIDs.
  }

  return trimmed;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parsePositiveIntegerEnv(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseBooleanEnv(name: string): boolean | undefined {
  const raw = optionalEnv(name);
  if (!raw) return undefined;
  if (/^(1|true|yes)$/iu.test(raw)) return true;
  if (/^(0|false|no)$/iu.test(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function callbackProbesFromEvents(events: unknown[]): CallbackProbe[] {
  const probes: CallbackProbe[] = [];
  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== "string") continue;
    const match = event.type.match(/^callback\.(.+)\.delivered$/u);
    if (!match?.[1]) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const statusMessageKey = typeof payload.statusMessageKey === "string" && payload.statusMessageKey.length > 0 ? payload.statusMessageKey : undefined;
    const externalMessageId = typeof payload.externalMessageId === "string" && payload.externalMessageId.length > 0 ? payload.externalMessageId : undefined;
    probes.push({
      kind: match[1],
      hasStatusMessageKey: Boolean(statusMessageKey),
      ...(externalMessageId ? { externalMessageId } : {}),
      hasExternalMessageId: Boolean(externalMessageId),
      returnedExternalMessageId: Boolean(externalMessageId),
      ...(typeof payload.lastError === "string" && payload.lastError.length > 0 ? { error: sanitizeError(payload.lastError) } : {})
    });
  }
  return probes;
}

function sanitizeCallbackProbe(entry: CallbackProbe): SanitizedCallbackProbe {
  return {
    kind: entry.kind,
    hasStatusMessageKey: entry.hasStatusMessageKey,
    hasExternalMessageId: entry.hasExternalMessageId,
    returnedExternalMessageId: entry.returnedExternalMessageId,
    ...(entry.error ? { error: entry.error } : {})
  };
}

function singleStatusCommentProbe(entries: CallbackProbe[]): SingleStatusCommentProbe {
  const statusEntries = entries.filter((entry) => entry.hasStatusMessageKey);
  const externalIds = new Set(statusEntries.map((entry) => entry.externalMessageId).filter((value): value is string => Boolean(value)));
  const [externalMessageId] = [...externalIds];
  return {
    statusCallbackCount: statusEntries.length,
    updateCount: Math.max(0, statusEntries.length - 1),
    reusedExternalMessageId: statusEntries.length > 1 && externalIds.size === 1,
    ...(externalMessageId ? { externalMessageId } : {})
  };
}

function singleStatusCommentGraphqlProbe(input: {
  evidence: LinearGraphqlEvidenceJson;
  singleStatusComment: SingleStatusCommentProbe;
}): SingleStatusCommentGraphqlProbe {
  const commentCreateCount = input.evidence.operationCounts.commentCreate ?? 0;
  const commentUpdateCount = input.evidence.operationCounts.commentUpdate ?? 0;
  const statusCommentUpdateCount = input.singleStatusComment.externalMessageId
    ? input.evidence.commentUpdateIds.filter((id) => id === input.singleStatusComment.externalMessageId).length
    : 0;
  return {
    commentCreateCount,
    commentUpdateCount,
    statusCommentUpdateCount,
    statusCommentUpdateVerified:
      Boolean(input.singleStatusComment.externalMessageId) &&
      statusCommentUpdateCount >= 1 &&
      statusCommentUpdateCount >= input.singleStatusComment.updateCount
  };
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(token, "[REDACTED_TOKEN]");
}

function redactId(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
