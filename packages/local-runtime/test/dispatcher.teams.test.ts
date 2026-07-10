import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import { startDispatcher } from "../src/dispatcher.js";

async function listenOnRandomPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Expected test server to listen on a TCP port.");
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
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

async function availablePort(): Promise<number> {
  const { server, port } = await listenOnRandomPort();
  await closeServer(server);
  return port;
}

/**
 * Serves a JWKS document over plain HTTP so `createTeamsAuthenticator`'s real
 * `jose`-backed remote JWKS fetch can verify a real, locally-signed Bot
 * Framework JWT — no authenticator/JWT-verification stub is injected into the
 * dispatcher; only the network address of Microsoft's JWKS endpoint is
 * overridden for the test.
 */
async function startJwksServer(jwk: JWK): Promise<{ url: string; close(): Promise<void> }> {
  let baseUrl = "";
  const server: HttpServer = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/openid") {
      res.end(JSON.stringify({ issuer: "https://api.botframework.com", jwks_uri: `${baseUrl}/keys` }));
      return;
    }
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: `${baseUrl}/openid`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

describe("local-runtime teams wiring", () => {
  it("mounts the teams webhook and creates a run for an addressed channel message", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    (jwk as JWK & { endorsements?: string[] }).endorsements = ["msteams"];
    const jwks = await startJwksServer(jwk);

    const port = await availablePort();
    const handle = startDispatcher({
      port,
      databasePath: ":memory:",
      teamsAppId: "app-teams-1",
      teamsAppPassword: "app-teams-secret",
      teamsWebhookPath: "/teams/messages",
      teamsOpenIdMetadataUrl: jwks.url
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const repoBinding = await fetch(`${baseUrl}/v1/repo-bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "teams",
          owner: "acme",
          repo: "demo",
          runnerId: "runner_1",
          workspacePath: "/Users/test/demo",
          defaultExecutor: "echo"
        })
      });
      expect(repoBinding.status).toBe(201);

      const channelBinding = await fetch(`${baseUrl}/v1/channel-bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "teams",
          accountId: "tenant-1",
          conversationId: "19:conversation-1@thread.tacv2",
          repoProvider: "teams",
          owner: "acme",
          repo: "demo"
        })
      });
      expect(channelBinding.status).toBe(201);

      const serviceUrl = "https://smba.trafficmanager.net/amer/";
      const token = await new SignJWT({ serviceurl: serviceUrl })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://api.botframework.com")
        .setAudience("app-teams-1")
        .setExpirationTime("5m")
        .sign(privateKey);

      const activity = {
        type: "message",
        id: "activity-1",
        channelId: "msteams",
        serviceUrl,
        text: "<at>OpenTag</at> please fix the failing test",
        from: { id: "29:user-1", name: "Alice", aadObjectId: "aad-1" },
        recipient: { id: "28:bot-1" },
        conversation: { id: "19:conversation-1@thread.tacv2", conversationType: "channel", tenantId: "tenant-1" },
        channelData: { tenant: { id: "tenant-1" }, team: { id: "team-1" }, channel: { id: "channel-1" } },
        entities: [{ type: "mention", text: "<at>OpenTag</at>", mentioned: { id: "28:bot-1", name: "OpenTag" } }]
      };

      const webhook = await fetch(`${baseUrl}/teams/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(activity)
      });
      expect(webhook.status).toBe(200);

      // The webhook app processes addressed messages in the background after
      // acknowledging with 200 (fire-and-forget), so poll the real runner
      // claim endpoint (the same seam the GitLab dispatcher test asserts
      // through) until the run created by the Teams mount becomes claimable.
      await vi.waitFor(
        async () => {
          const claim = await fetch(`${baseUrl}/v1/runners/runner_1/claim`, {
            method: "POST"
          });
          expect(claim.status).toBe(200);
          await expect(claim.json()).resolves.toMatchObject({
            event: {
              source: "teams",
              metadata: {
                repoProvider: "teams",
                owner: "acme",
                repo: "demo"
              }
            },
            run: {
              status: "assigned"
            }
          });
        },
        { timeout: 15_000, interval: 25 }
      );

      // The claim above only proves the run was committed server-side; the
      // webhook's own background `createRun` HTTP call (a loopback request the
      // dispatcher process makes to itself) can take noticeably longer to
      // finish draining its response on this machine. Give it a wide margin
      // before the `finally` block force-closes all connections, so teardown
      // doesn't log a spurious "socket closed" error for an already-successful
      // request that just hadn't finished reading its own response yet.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    } finally {
      await handle.close();
      await jwks.close();
    }
  }, 15_000);
});
