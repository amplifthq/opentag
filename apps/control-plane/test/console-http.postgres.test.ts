import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";
import { createConsoleReadModel } from "../src/modules/console-reads/index.js";
import {
  createIdentityModule,
  createLoginThrottleKeyFactory,
} from "../src/modules/identity/index.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("same-origin console HTTP identity", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let identityNumber = 0;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("sets an HTTP-only session, scopes reads, and enforces mutation origin", async () => {
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T11:00:00.000Z") },
      idFactory: (kind) => `${kind}_http_${++identityNumber}`,
      opaqueBearerFactory: (kind) => `console_${kind}_bearer_material`.padEnd(48, "_"),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory: createLoginThrottleKeyFactory("t".repeat(32)),
    });
    await identity.provisionOwner({
      organizationId: "org_console_http",
      organizationName: "Console HTTP",
      email: "owner-http@example.test",
      displayName: "HTTP owner",
      password: "correct horse battery staple",
    });
    const runnerDirectory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T11:00:00.000Z") },
      idFactory: () => "credential_console_http",
      tokenFactory: () => "runtime_console_http_secret",
    });
    const registered = await runnerDirectory.register({
      organizationId: "org_console_http",
      organizationName: "Console HTTP",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_console_http_runner",
        operationId: "operation_console_http_runner",
        runnerId: "runner_console_http",
        capabilities: ["relay.readiness.v1"],
      },
    });
    if (registered.kind !== "created") throw new Error("runner registration failed");
    const authenticated = await runnerDirectory.authenticate(registered.response.runnerToken);
    if (authenticated.kind !== "authenticated") throw new Error("runner authentication failed");
    const application = createControlPlaneApplication({
      capabilities: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1",
        capabilities: [],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "local", releaseSha: "local" },
      },
      readiness: { check: async () => ({ ready: true }) },
      console: {
        identity,
        reads: createConsoleReadModel({ pool: fixture.pool }),
        publicOrigin: "http://control.test",
      },
    });

    const login = await application.fetch(
      new Request("http://control.test/api/console/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://control.test",
        },
        body: JSON.stringify({
          email: "owner-http@example.test",
          password: "correct horse battery staple",
        }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toMatch(/opentag_session=.*HttpOnly.*SameSite=Strict/iu);
    expect(cookie).not.toMatch(/correct horse/iu);

    const session = await application.fetch(
      new Request("http://control.test/api/console/session", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      principal: {
        organizationId: "org_console_http",
        role: "owner",
      },
    });

    const forbiddenLogout = await application.fetch(
      new Request("http://control.test/api/console/session", {
        method: "DELETE",
        headers: {
          cookie: cookie?.split(";")[0] ?? "",
          origin: "https://attacker.test",
        },
      }),
    );
    expect(forbiddenLogout.status).toBe(403);

    const runners = await application.fetch(
      new Request("http://control.test/api/console/runners", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(runners.status).toBe(200);
    expect(await runners.json()).toMatchObject({
      runners: [{ runnerId: "runner_console_http" }],
    });

    const presence = await application.fetch(
      new Request("http://control.test/api/console/presence", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(presence.status).toBe(200);
    expect(await presence.json()).toEqual({
      presence: {
        state: "setup_required",
        reason: "No active Slack installation and binding are configured.",
        agents: [],
      },
    });

    const targets = await application.fetch(
      new Request("http://control.test/api/console/project-targets", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(targets.status).toBe(200);
    expect(await targets.json()).toEqual({ targets: [] });

    const slackBindingDigest = `sha256:${"a".repeat(64)}`;
    const installedAt = new Date("2026-08-15T11:00:00.000Z");
    await fixture.pool.query(
      `INSERT INTO cp_source_app_installation(
         organization_id,installation_id,source_app_id,app_instance_id,binding_digest,
         credential_generation,credential_generation_digest,state,created_at,updated_at)
       VALUES('org_console_http','installation_console_http','slack','A_CONSOLE',$1,1,$2,
         'active',$3,$3)`,
      [slackBindingDigest, `sha256:${"b".repeat(64)}`, installedAt],
    );
    await fixture.pool.query(
      `INSERT INTO cp_source_binding(
         organization_id,binding_id,installation_id,binding_digest,state,created_at,updated_at)
       VALUES('org_console_http','binding_console_http','installation_console_http',$1,
         'active',$2,$2)`,
      [slackBindingDigest, installedAt],
    );
    await fixture.pool.query(
      `INSERT INTO cp_slack_installation(
         organization_id,installation_id,binding_id,project_target_id,publication_mode,
         team_id,app_id,channel_id,bot_user_id,signing_secret_ref,member_user_ids,
         operator_user_ids,admin_user_ids,bot_token_ref,route_identity,created_at,updated_at)
       VALUES('org_console_http','installation_console_http','binding_console_http',
         'target_console_http','proposal_only','T_CONSOLE','A_CONSOLE','C_CONSOLE',
         'U_APP','env:SLACK_SIGNING_SECRET',ARRAY['U1'],ARRAY['U1'],ARRAY['U1'],
         'env:SLACK_BOT_TOKEN','route_console_http',$1,$1)`,
      [installedAt],
    );

    const evidence = await application.fetch(
      new Request("http://control.test/api/console/evidence", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toEqual({
      materialActions: [],
      permissions: [],
    });

    const target = {
      projectTargetId: "target_console_http",
      provider: "github" as const,
      owner: "amplifthq",
      repo: "opentag",
      defaultExecutor: "codex",
      defaultBranch: "main",
    };
    await expect(runnerDirectory.upsertProjectTarget({
      principal: authenticated.principal,
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.repository-binding.v1"],
        requestId: "request_target_console_http",
        expectedAuthority: {
          credentialId: authenticated.principal.credentialId,
          registrationGeneration: authenticated.principal.registrationGeneration,
          credentialGeneration: authenticated.principal.credentialGeneration,
        },
        target,
      },
    })).resolves.toMatchObject({ kind: "upserted" });

    const targetsAfterCreate = await application.fetch(
      new Request("http://control.test/api/console/project-targets", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(await targetsAfterCreate.json()).toMatchObject({
      targets: [{
        projectTargetId: "target_console_http",
        runnerId: "runner_console_http",
        owner: "amplifthq",
        repo: "opentag",
      }],
    });

    const createdKey = await application.fetch(
      new Request("http://control.test/api/console/api-keys", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie?.split(";")[0] ?? "",
          origin: "http://control.test",
        },
        body: JSON.stringify({ label: "operator", scopes: ["run:read"] }),
      }),
    );
    expect(createdKey.status).toBe(201);
    expect(await createdKey.json()).toMatchObject({
      apiKey: { label: "operator", scopes: ["run:read"] },
      token: "console_api_key_bearer_material".padEnd(48, "_"),
    });

    const listedKeys = await application.fetch(
      new Request("http://control.test/api/console/api-keys", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(listedKeys.status).toBe(200);
    expect(JSON.stringify(await listedKeys.json())).not.toContain(
      "console_api_key_secret",
    );

    const forbiddenKeyCreation = await application.fetch(
      new Request("http://control.test/api/console/api-keys", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie?.split(";")[0] ?? "",
          origin: "https://attacker.test",
        },
        body: JSON.stringify({ label: "forbidden", scopes: ["run:read"] }),
      }),
    );
    expect(forbiddenKeyCreation.status).toBe(403);
  });
});
