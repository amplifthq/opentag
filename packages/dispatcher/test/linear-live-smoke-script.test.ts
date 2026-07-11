import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

describe("Linear live workspace smoke script", () => {
  it("uses the fixed hosted OAuth webhook path with a mocked Linear GraphQL endpoint", async () => {
    const queries: string[] = [];
    const issueLookupVariables: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const parsed = body ? (JSON.parse(body) as { query?: string; variables?: unknown }) : {};
        const query = parsed.query ?? "";
        queries.push(query);
        res.setHeader("content-type", "application/json");

        if (query.includes("OpenTagLinearLiveSmokeIssue")) {
          issueLookupVariables.push(parsed.variables);
          res.end(
            JSON.stringify({
              data: {
                issue: {
                  id: "issue_mock_123",
                  identifier: "ENG-123",
                  title: "Mock Linear smoke issue",
                  url: "https://linear.app/acme/issue/ENG-123/mock",
                  priority: 2,
                  team: { id: "team_eng", key: "ENG", name: "Engineering" }
                }
              }
            })
          );
          return;
        }

        if (query.includes("OpenTagLinearWorkspaceIdentity")) {
          res.end(
            JSON.stringify({
              data: {
                viewer: { id: "app_user_mock_123", name: "OpenTag", app: true },
                organization: { id: "org_mock_123", name: "Acme", urlKey: "acme" }
              }
            })
          );
          return;
        }

        if (query.includes("OpenTagLinearMetadataTeams")) {
          res.end(
            JSON.stringify({
              data: {
                teams: {
                  nodes: [{ id: "team_eng", key: "ENG", name: "Engineering", displayName: "Engineering", color: "#00aa88" }],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            })
          );
          return;
        }

        if (query.includes("OpenTagLinearMetadataUsers")) {
          res.end(
            JSON.stringify({
              data: {
                users: {
                  nodes: [
                    { id: "user_ada", name: "Ada Lovelace", displayName: "Ada", email: "ada@example.com", active: true, app: false }
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            })
          );
          return;
        }

        if (query.includes("OpenTagLinearMetadataWorkflowStates")) {
          res.end(
            JSON.stringify({
              data: {
                workflowStates: {
                  nodes: [
                    { id: "state_started", name: "In Progress", type: "started", color: "#f2c94c", team: { id: "team_eng", key: "ENG", name: "Engineering" } }
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            })
          );
          return;
        }

        if (query.includes("OpenTagLinearMetadataIssueLabels")) {
          res.end(
            JSON.stringify({
              data: {
                issueLabels: {
                  nodes: [
                    { id: "label_bug", name: "Bug", color: "#ff0000", isGroup: false, team: { id: "team_eng", key: "ENG", name: "Engineering" } }
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            })
          );
          return;
        }

        if (query.includes("commentCreate")) {
          res.end(
            JSON.stringify({
              data: {
                commentCreate: {
                  success: true,
                  comment: {
                    id: `comment_${queries.length}`,
                    url: "https://linear.app/acme/issue/ENG-123/mock#comment"
                  }
                }
              }
            })
          );
          return;
        }

        if (query.includes("commentUpdate")) {
          res.end(
            JSON.stringify({
              data: {
                commentUpdate: {
                  success: true,
                  comment: {
                    id: "comment_1",
                    url: "https://linear.app/acme/issue/ENG-123/mock#comment"
                  }
                }
              }
            })
          );
          return;
        }

        if (query.includes("issueUpdate")) {
          res.end(
            JSON.stringify({
              data: {
                issueUpdate: {
                  success: true,
                  issue: { url: "https://linear.app/acme/issue/ENG-123/mock" }
                }
              }
            })
          );
          return;
        }

        if (query.includes("agentSessionUpdate")) {
          res.end(JSON.stringify({ data: { agentSessionUpdate: { success: true } } }));
          return;
        }

        if (query.includes("agentActivityCreate")) {
          res.end(
            JSON.stringify({
              data: {
                agentActivityCreate: {
                  success: true,
                  agentActivity: { id: `activity_${queries.length}` }
                }
              }
            })
          );
          return;
        }

        res.end(JSON.stringify({ data: {} }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const env = {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=development"].filter(Boolean).join(" "),
        OPENTAG_LINEAR_SMOKE_TOKEN: "Bearer mock_linear_token",
        OPENTAG_LINEAR_SMOKE_ISSUE: "https://linear.app/acme/issue/ENG-123/mock-linear-smoke",
        OPENTAG_LINEAR_SMOKE_GRAPHQL_URL: `http://127.0.0.1:${address.port}/graphql`,
        OPENTAG_LINEAR_SMOKE_AGENT_SESSION_ID: "agent_session_mock_123"
      };
      delete env.OPENTAG_LINEAR_SMOKE_WEBHOOK_SECRET;

      const result = await runSmokeScript(env);
      const output = JSON.parse(result.stdout) as {
        ok?: boolean;
        runId?: string;
        metrics?: { applyOutcomeCounts?: { applied?: number } };
        callbackLog?: Array<{ kind?: string; hasExternalMessageId?: boolean }>;
        singleStatusComment?: {
          statusCallbackCount?: number;
          updateCount?: number;
          reusedExternalMessageId?: boolean;
          graphql?: {
            commentCreateCount?: number;
            commentUpdateCount?: number;
            statusCommentUpdateCount?: number;
            statusCommentUpdateVerified?: boolean;
          };
        };
        hostedOAuthWebhook?: {
          path?: string;
          organizationId?: string;
        };
        oauthActor?: {
          viewerIsApp?: boolean;
          appActorVerified?: boolean;
          compatibilityMode?: boolean;
          organizationId?: string;
        };
        metadataDiscovery?: {
          teams?: number;
          users?: number;
          workflowStates?: number;
          issueLabels?: number;
          issueTeamDiscovered?: boolean;
          mappingDomains?: string[];
          mappingValueCounts?: Record<string, number>;
        };
        linearGraphqlEvidence?: {
          requestCount?: number;
          operationCounts?: Record<string, number>;
          commentUpdateIds?: string[];
          requiredOperations?: Record<string, boolean>;
        };
        agentSessionSmoke?: {
          runId?: string;
          metrics?: { humanCallbackCount?: number };
          callbackLog?: Array<{ kind?: string; hasExternalMessageId?: boolean }>;
          prompted?: {
            queuedFollowUpId?: string;
            queuedBehindRunId?: string;
            followUpStatus?: string;
            promotedFromQueuedFollowUp?: boolean;
            runId?: string;
            metrics?: { humanCallbackCount?: number };
            callbackLog?: Array<{ kind?: string; hasExternalMessageId?: boolean }>;
          };
        };
      };

      expect(output.ok).toBe(true);
      expect(output.runId).toMatch(/^run_/);
      expect(output.metrics?.applyOutcomeCounts?.applied).toBe(1);
      expect(output.singleStatusComment).toMatchObject({
        statusCallbackCount: expect.any(Number),
        updateCount: expect.any(Number),
        reusedExternalMessageId: true,
        graphql: {
          commentCreateCount: expect.any(Number),
          commentUpdateCount: expect.any(Number),
          statusCommentUpdateCount: expect.any(Number),
          statusCommentUpdateVerified: true
        }
      });
      expect(output.singleStatusComment?.statusCallbackCount).toBeGreaterThanOrEqual(2);
      expect(output.singleStatusComment?.updateCount).toBeGreaterThanOrEqual(1);
      expect(output.singleStatusComment?.graphql?.commentUpdateCount).toBeGreaterThanOrEqual(output.singleStatusComment?.updateCount ?? 0);
      expect(output.singleStatusComment?.graphql?.statusCommentUpdateCount).toBeGreaterThanOrEqual(output.singleStatusComment?.updateCount ?? 0);
      expect(output.hostedOAuthWebhook).toMatchObject({
        path: "/linear/oauth/webhooks",
        organizationId: expect.stringMatching(/^org_.*_123$/)
      });
      expect(output.oauthActor).toMatchObject({
        viewerIsApp: true,
        appActorVerified: true,
        compatibilityMode: false,
        organizationId: expect.stringMatching(/^org_.*_123$/)
      });
      expect(output.metadataDiscovery).toMatchObject({
        teams: 1,
        users: 1,
        workflowStates: 1,
        issueLabels: 1,
        issueTeamDiscovered: true,
        mappingDomains: ["assignee", "label", "priority", "status", "team"]
      });
      expect(output.metadataDiscovery?.mappingValueCounts).toMatchObject({
        assignee: 3,
        label: 2,
        priority: 5,
        status: 3,
        team: 3
      });
      expect(output.linearGraphqlEvidence?.requestCount).toBeGreaterThanOrEqual(11);
      expect(output.linearGraphqlEvidence?.operationCounts).toMatchObject({
        OpenTagLinearLiveSmokeIssue: 1,
        OpenTagLinearWorkspaceIdentity: 1,
        OpenTagLinearMetadataTeams: 1,
        OpenTagLinearMetadataUsers: 1,
        OpenTagLinearMetadataWorkflowStates: 1,
        OpenTagLinearMetadataIssueLabels: 1,
        commentCreate: expect.any(Number),
        commentUpdate: expect.any(Number),
        issueUpdate: 1,
        agentSessionUpdate: expect.any(Number),
        agentActivityCreate: expect.any(Number)
      });
      expect(output.linearGraphqlEvidence?.operationCounts?.commentCreate).toBeGreaterThanOrEqual(1);
      expect(output.linearGraphqlEvidence?.operationCounts?.commentUpdate).toBeGreaterThanOrEqual(1);
      expect(output.linearGraphqlEvidence?.commentUpdateIds?.length).toBeGreaterThanOrEqual(output.singleStatusComment?.updateCount ?? 0);
      expect(output.linearGraphqlEvidence?.operationCounts?.agentSessionUpdate).toBeGreaterThanOrEqual(2);
      expect(output.linearGraphqlEvidence?.operationCounts?.agentActivityCreate).toBeGreaterThanOrEqual(6);
      expect(output.linearGraphqlEvidence?.requiredOperations).toMatchObject({
        issueLookup: true,
        workspaceIdentity: true,
        metadataTeams: true,
        metadataUsers: true,
        metadataWorkflowStates: true,
        metadataIssueLabels: true,
        commentCreate: true,
        commentUpdate: true,
        issueUpdate: true,
        agentSessionUpdate: true,
        agentActivityCreate: true
      });
      expect(output.callbackLog?.some((entry) => entry.kind === "acknowledgement" && entry.hasExternalMessageId)).toBe(true);
      expect(output.callbackLog?.some((entry) => entry.kind === "final" && entry.hasExternalMessageId)).toBe(true);
      expect(output.agentSessionSmoke?.runId).toMatch(/^run_/);
      expect(output.agentSessionSmoke?.metrics?.humanCallbackCount).toBeGreaterThanOrEqual(2);
      expect(output.agentSessionSmoke?.callbackLog?.some((entry) => entry.kind === "acknowledgement" && entry.hasExternalMessageId)).toBe(true);
      expect(output.agentSessionSmoke?.callbackLog?.some((entry) => entry.kind === "final" && entry.hasExternalMessageId)).toBe(true);
      expect(output.agentSessionSmoke?.prompted?.queuedFollowUpId).toEqual(expect.any(String));
      expect(output.agentSessionSmoke?.prompted?.queuedBehindRunId).toBe(output.agentSessionSmoke?.runId);
      expect(output.agentSessionSmoke?.prompted?.followUpStatus).toBe("promoted");
      expect(output.agentSessionSmoke?.prompted?.promotedFromQueuedFollowUp).toBe(true);
      expect(output.agentSessionSmoke?.prompted?.runId).toMatch(/^run_/);
      expect(output.agentSessionSmoke?.prompted?.runId).not.toBe(output.agentSessionSmoke?.prompted?.queuedFollowUpId);
      expect(output.agentSessionSmoke?.prompted?.metrics?.humanCallbackCount).toBeGreaterThanOrEqual(2);
      expect(output.agentSessionSmoke?.prompted?.callbackLog?.some((entry) => entry.kind === "acknowledgement" && entry.hasExternalMessageId)).toBe(true);
      expect(output.agentSessionSmoke?.prompted?.callbackLog?.some((entry) => entry.kind === "final" && entry.hasExternalMessageId)).toBe(true);
      expect(issueLookupVariables).toEqual([{ id: "ENG-123" }]);
      expect(queries.some((query) => query.includes("commentCreate"))).toBe(true);
      expect(queries.some((query) => query.includes("OpenTagLinearWorkspaceIdentity"))).toBe(true);
      expect(queries.some((query) => query.includes("OpenTagLinearMetadataTeams"))).toBe(true);
      expect(queries.some((query) => query.includes("OpenTagLinearMetadataUsers"))).toBe(true);
      expect(queries.some((query) => query.includes("OpenTagLinearMetadataWorkflowStates"))).toBe(true);
      expect(queries.some((query) => query.includes("OpenTagLinearMetadataIssueLabels"))).toBe(true);
      expect(queries.some((query) => query.includes("commentUpdate"))).toBe(true);
      expect(queries.some((query) => query.includes("issueUpdate"))).toBe(true);
      expect(queries.some((query) => query.includes("agentSessionUpdate"))).toBe(true);
      expect(queries.some((query) => query.includes("agentActivityCreate"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }, 45_000);
});

async function runSmokeScript(env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const command = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const child = spawn(command, ["pnpm", "--dir", "apps/dispatcher", "exec", "tsx", "../../scripts/dev/run-linear-workspace-live-test.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  if (code !== 0) {
    throw new Error(`Linear live smoke script failed with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { stdout, stderr };
}
