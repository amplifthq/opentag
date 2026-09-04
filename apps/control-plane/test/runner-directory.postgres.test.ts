import {
  computeGitHubProjectTargetBindingDigestV1,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  RunnerReadinessReceiptEnvelopeV1Schema,
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerRegistrationRequestV1Schema,
  type RunnerRegistrationRequestV1,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

function registrationRequest(
  operationId = "operation_register_runner_1",
): RunnerRegistrationRequestV1 {
  return RunnerRegistrationRequestV1Schema.parse({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.registration.v1"],
    requestId: "request_register_runner_1",
    operationId,
    runnerId: "runner_1",
    displayName: "Build runner",
    capabilities: [
      "relay.claim-fence.v1",
      "relay.hosted-admission.v1",
      "relay.hosted-claim.v1",
      "relay.lifecycle.v1",
      "relay.readiness.v1",
      "relay.source-content-redeem.v1",
    ],
  });
}

async function bindSlackProjectTarget(input: {
  pool: Awaited<ReturnType<typeof createIsolatedPostgres>>["pool"];
  organizationId: string;
  projectTargetId: string;
  suffix: string;
}) {
  const now = new Date("2026-08-15T06:02:00.000Z");
  const installationId = `installation_${input.suffix}`;
  const bindingId = `binding_${input.suffix}`;
  const bindingDigest = `sha256:${input.suffix.padEnd(64, "a").slice(0, 64)}`;
  await input.pool.query(
    `INSERT INTO cp_source_app_installation(
       organization_id,installation_id,source_app_id,app_instance_id,binding_digest,
       credential_generation,credential_generation_digest,state,created_at,updated_at)
     VALUES($1,$2,'slack',$3,$4,1,$5,'active',$6,$6)`,
    [input.organizationId, installationId, `app_${input.suffix}`, bindingDigest,
      `sha256:${input.suffix.padEnd(64, "b").slice(0, 64)}`, now],
  );
  await input.pool.query(
    `INSERT INTO cp_source_binding(
       organization_id,binding_id,installation_id,binding_digest,state,created_at,updated_at)
     VALUES($1,$2,$3,$4,'active',$5,$5)`,
    [input.organizationId, bindingId, installationId, bindingDigest, now],
  );
  await input.pool.query(
    `INSERT INTO cp_slack_installation(
       organization_id,installation_id,binding_id,project_target_id,publication_mode,
       team_id,app_id,channel_id,bot_user_id,signing_secret_ref,member_user_ids,
       operator_user_ids,admin_user_ids,bot_token_ref,route_identity,created_at,updated_at)
     VALUES($1,$2,$3,$4,'proposal_only',$5,$6,$7,$8,'env:SLACK_SIGNING_SECRET',
       ARRAY['U1'],ARRAY['U1'],ARRAY['U1'],'env:SLACK_BOT_TOKEN',$9,$10,$10)`,
    [input.organizationId, installationId, bindingId, input.projectTargetId,
      `T_${input.suffix}`, `A_${input.suffix}`, `C_${input.suffix}`,
      `U_APP_${input.suffix}`, `route_${input.suffix}`, now],
  );
}

async function readinessReceipt(input: {
  organizationId: string;
  runnerId: string;
  credentialId: string;
  registrationGeneration: number;
  suffix: string;
}) {
  const observedAt = "2026-08-15T06:04:00.000Z";
  const payload = {
    readinessId: `readiness_${input.suffix}`,
    runnerId: input.runnerId,
    registrationGeneration: input.registrationGeneration,
    capabilities: ["relay.readiness.v1"] as const,
    executors: [],
    targets: [],
    observedAt,
    expiresAt: "2026-08-15T06:09:00.000Z",
  };
  const seed = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptId: `readiness_receipt_${input.suffix}`,
    organizationId: input.organizationId,
    operationId: `operation_readiness_${input.suffix}`,
    requiredCapabilities: ["relay.readiness.v1"] as const,
    producer: {
      kind: "runner" as const,
      id: input.runnerId,
      credentialId: input.credentialId,
      registrationGeneration: input.registrationGeneration,
    },
    identity: {
      namespace: "opentag.control.receipt/runner-readiness/v1" as const,
      parts: [
        input.organizationId,
        input.runnerId,
        String(input.registrationGeneration),
        payload.readinessId,
      ],
    },
    observedAt,
    payloadDigest: await computeControlPayloadDigestV1(payload),
    receiptDigest: `sha256:${"0".repeat(64)}`,
    receiptKind: "runner_readiness" as const,
    payload,
  };
  const { receiptDigest: _receiptDigest, ...digestInput } = seed;
  return RunnerReadinessReceiptEnvelopeV1Schema.parse({
    ...seed,
    receiptDigest: await computeControlReceiptDigestV1(digestInput),
  });
}

describe.skipIf(!TEST_DATABASE_URL)("Runner Directory PostgreSQL module", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let tokenNumber = 0;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("issues a non-recoverable runtime credential and replays metadata only", async () => {
    const directory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T06:00:00.000Z") },
      tokenFactory: () => `runtime_secret_${++tokenNumber}`,
      idFactory: (kind) => `${kind}_1`,
    });
    const request = registrationRequest();

    const created = await directory.register({
      organizationId: "org_1",
      organizationName: "Acme",
      request,
    });
    const replayed = await directory.register({
      organizationId: "org_1",
      organizationName: "Acme",
      request,
    });

    expect(created).toMatchObject({
      kind: "created",
      response: {
        replayed: false,
        organizationId: "org_1",
        runnerId: "runner_1",
        credentialId: "credential_1",
        registrationGeneration: 1,
        credentialGeneration: 1,
        runnerToken: "runtime_secret_1",
      },
    });
    expect(replayed).toMatchObject({
      kind: "replayed",
      response: {
        replayed: true,
        organizationId: "org_1",
        runnerId: "runner_1",
        credentialId: "credential_1",
      },
    });
    expect(replayed.response).not.toHaveProperty("runnerToken");
    expect(tokenNumber).toBe(1);

    const stored = await fixture.pool.query<{
      token_hash: string;
      response: Record<string, unknown>;
    }>(
      `SELECT credential.token_hash, operation.response
       FROM cp_runner_credential credential
       JOIN cp_runner_operation operation USING (organization_id, runner_id)
       WHERE credential.runner_id = $1`,
      ["runner_1"],
    );
    expect(stored.rows[0]?.token_hash).not.toContain("runtime_secret_1");
    expect(JSON.stringify(stored.rows[0]?.response)).not.toContain(
      "runtime_secret_1",
    );
    const audit = await fixture.pool.query<{
      operation_kind: string;
      event: unknown;
    }>(
      `SELECT operation_kind, event FROM cp_management_audit_event
       WHERE organization_id = 'org_1' AND resource_id = 'runner_1'`,
    );
    expect(audit.rows.map(({ operation_kind }) => operation_kind)).toEqual([
      "runner.register",
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain("runtime_secret_1");
  });

  it("authenticates runtime authority without leaking another tenant", async () => {
    const directory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T06:01:00.000Z") },
      tokenFactory: () => "second_runtime_secret",
      idFactory: (kind) => `${kind}_2`,
    });
    await directory.register({
      organizationId: "org_2",
      organizationName: "Other",
      request: {
        ...registrationRequest("operation_register_runner_2"),
        requestId: "request_register_runner_2",
        runnerId: "runner_2",
      },
    });

    await expect(directory.authenticate("second_runtime_secret")).resolves.toEqual({
      kind: "authenticated",
      principal: {
        organizationId: "org_2",
        runnerId: "runner_2",
        credentialId: "credential_2",
        registrationGeneration: 1,
        credentialGeneration: 1,
      },
    });
    await expect(directory.authenticate("wrong-secret")).resolves.toEqual({
      kind: "invalid_credential",
    });
  });

  it("reprovisions a lost runtime credential once and revokes the old token", async () => {
    let credentialNumber = 0;
    let runtimeTokenNumber = 0;
    const directory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T06:01:30.000Z") },
      tokenFactory: () => `recovery_runtime_secret_${++runtimeTokenNumber}`,
      idFactory: (kind) => `${kind}_recovery_${++credentialNumber}`,
    });
    const registration = await directory.register({
      organizationId: "org_recovery",
      organizationName: "Recovery",
      request: {
        ...registrationRequest("operation_register_recovery"),
        requestId: "request_register_recovery",
        runnerId: "runner_recovery",
      },
    });
    expect(registration.kind).toBe("created");
    if (registration.kind !== "created") throw new Error("registration failed");
    const request = RunnerCredentialReprovisionRequestV1Schema.parse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.credential-reprovision.v1"],
      requestId: "request_reprovision_recovery",
      operationId: "operation_reprovision_recovery",
      runnerId: "runner_recovery",
      recoveryCredentialId: registration.response.credentialId,
      expectedRegistrationGeneration: 1,
      expectedCredentialGeneration: 1,
    });

    const created = await directory.reprovision({
      organizationId: "org_recovery",
      request,
    });
    const replayed = await directory.reprovision({
      organizationId: "org_recovery",
      request,
    });

    expect(created).toMatchObject({
      kind: "created",
      response: {
        replayed: false,
        runnerId: "runner_recovery",
        registrationGeneration: 2,
        credentialGeneration: 2,
        credentialId: "credential_recovery_2",
        runnerToken: "recovery_runtime_secret_2",
      },
    });
    expect(replayed).toMatchObject({
      kind: "replayed",
      response: {
        replayed: true,
        registrationGeneration: 2,
        credentialGeneration: 2,
      },
    });
    expect(replayed.response).not.toHaveProperty("runnerToken");
    await expect(
      directory.authenticate("recovery_runtime_secret_1"),
    ).resolves.toEqual({ kind: "invalid_credential" });
    await expect(
      directory.authenticate("recovery_runtime_secret_2"),
    ).resolves.toMatchObject({
      kind: "authenticated",
      principal: {
        runnerId: "runner_recovery",
        registrationGeneration: 2,
        credentialGeneration: 2,
      },
    });
    const audit = await fixture.pool.query<{ operation_kind: string }>(
      `SELECT operation_kind FROM cp_management_audit_event
       WHERE organization_id = 'org_recovery' AND resource_id = 'runner_recovery'
       ORDER BY sequence_id`,
    );
    expect(audit.rows.map(({ operation_kind }) => operation_kind)).toEqual([
      "runner.register",
      "runner.reprovision",
    ]);
  });

  it("rejects a second runner for the same organization without side effects", async () => {
    const directory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T06:02:00.000Z") },
      tokenFactory: () => "must_not_be_used",
      idFactory: (kind) => `${kind}_3`,
    });

    await expect(
      directory.register({
        organizationId: "org_1",
        organizationName: "Acme",
        request: {
          ...registrationRequest("operation_register_runner_conflict"),
          requestId: "request_register_runner_conflict",
          runnerId: "runner_2",
        },
      }),
    ).resolves.toEqual({ kind: "conflict", reason: "runner_already_registered" });
    await expect(fixture.pool.query(
      "SELECT runner_id FROM cp_runner WHERE organization_id = 'org_1' ORDER BY runner_id",
    ).then(({ rows }) => rows)).resolves.toEqual([{ runner_id: "runner_1" }]);
    await expect(fixture.pool.query(
      "SELECT count(*)::int AS count FROM cp_runner_credential WHERE organization_id = 'org_1'",
    ).then(({ rows }) => rows[0])).resolves.toEqual({ count: 1 });
    await expect(fixture.pool.query(
      "SELECT count(*)::int AS count FROM cp_management_audit_event WHERE organization_id = 'org_1' AND resource_id = 'runner_2'",
    ).then(({ rows }) => rows[0])).resolves.toEqual({ count: 0 });
  });

  it("stores verified readiness and returns a tenant-scoped control context", async () => {
    const directory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T06:03:00.000Z") },
      tokenFactory: () => "unused",
      idFactory: (kind) => `${kind}_4`,
    });
    const authenticated = await directory.authenticate("runtime_secret_1");
    expect(authenticated.kind).toBe("authenticated");
    if (authenticated.kind !== "authenticated") throw new Error("not authenticated");

    const target = {
      projectTargetId: "target_1",
      provider: "github" as const,
      owner: "acme",
      repo: "demo",
      defaultExecutor: "executor_acp",
      defaultBranch: "main",
    };
    const targetBindingDigest = await computeGitHubProjectTargetBindingDigestV1(target);
    const targetCommand = {
      principal: authenticated.principal,
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.repository-binding.v1"],
        requestId: "request_target_1",
        expectedAuthority: {
          credentialId: authenticated.principal.credentialId,
          registrationGeneration: authenticated.principal.registrationGeneration,
          credentialGeneration: authenticated.principal.credentialGeneration,
        },
        target,
      },
    };
    await expect(directory.upsertProjectTarget(targetCommand)).resolves.toEqual({
      kind: "conflict",
      reason: "target_not_bound_to_slack",
    });
    await bindSlackProjectTarget({ pool: fixture.pool, organizationId: "org_1",
      projectTargetId: target.projectTargetId, suffix: "target1" });
    await expect(directory.upsertProjectTarget(targetCommand))
      .resolves.toMatchObject({ kind: "upserted" });
    const payload = {
      readinessId: "readiness_1",
      runnerId: "runner_1",
      registrationGeneration: 1,
      capabilities: [
        "relay.claim-fence.v1",
        "relay.hosted-admission.v1",
        "relay.hosted-claim.v1",
        "relay.lifecycle.v1",
        "relay.readiness.v1",
        "relay.source-content-redeem.v1",
      ],
      executors: [
        {
          executorId: "executor_acp",
          adapterVersion: "1.0.0",
          capabilityDigest: `sha256:${"b".repeat(64)}`,
          state: "ready" as const,
        },
      ],
      targets: [
        {
          projectTargetId: "target_1",
          bindingDigest: targetBindingDigest,
          state: "ready" as const,
        },
      ],
      observedAt: "2026-08-15T06:03:00.000Z",
      expiresAt: "2026-08-15T06:08:00.000Z",
    };
    const seed = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptId: "readiness_receipt_1",
      organizationId: "org_1",
      operationId: "operation_readiness_1",
      requiredCapabilities: ["relay.readiness.v1"] as const,
      producer: {
        kind: "runner" as const,
        id: "runner_1",
        credentialId: "credential_1",
        registrationGeneration: 1,
      },
      identity: {
        namespace: "opentag.control.receipt/runner-readiness/v1" as const,
        parts: ["org_1", "runner_1", "1", "readiness_1"],
      },
      observedAt: payload.observedAt,
      payloadDigest: await computeControlPayloadDigestV1(payload),
      receiptDigest: `sha256:${"0".repeat(64)}`,
      receiptKind: "runner_readiness" as const,
      payload,
    };
    const { receiptDigest: _ignored, ...digestInput } = seed;
    const receipt = RunnerReadinessReceiptEnvelopeV1Schema.parse({
      ...seed,
      receiptDigest: await computeControlReceiptDigestV1(digestInput),
    });

    await expect(
      directory.recordReadiness({
        principal: authenticated.principal,
        receipt,
      }),
    ).resolves.toEqual({ kind: "recorded", receipt });
    await expect(
      directory.getControlContext(authenticated.principal),
    ).resolves.toMatchObject({
      contextKind: "runner_control",
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      targets: [
        {
          projectTargetId: "target_1",
          bindingDigest: targetBindingDigest,
          owner: "acme",
          repo: "demo",
        },
      ],
    });
  });

  it("serializes readiness with credential rotation and rejects the stale authority", async () => {
    const directory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T06:04:00.000Z") },
      tokenFactory: () => "runtime_authority_secret",
      idFactory: () => "credential_authority_1",
    });
    const registered = await directory.register({
      organizationId: "org_readiness_authority",
      organizationName: "Readiness authority",
      request: {
        ...registrationRequest("operation_register_readiness_authority"),
        requestId: "request_register_readiness_authority",
        runnerId: "runner_readiness_authority",
        capabilities: ["relay.readiness.v1"],
      },
    });
    expect(registered.kind).toBe("created");
    if (registered.kind !== "created") throw new Error("registration failed");
    const authenticated = await directory.authenticate(registered.response.runnerToken);
    expect(authenticated.kind).toBe("authenticated");
    if (authenticated.kind !== "authenticated") throw new Error("authentication failed");
    const receipt = await readinessReceipt({
      organizationId: authenticated.principal.organizationId,
      runnerId: authenticated.principal.runnerId,
      credentialId: authenticated.principal.credentialId,
      registrationGeneration: authenticated.principal.registrationGeneration,
      suffix: "authority_race",
    });

    const rotation = await fixture.pool.connect();
    try {
      await rotation.query("BEGIN");
      await rotation.query(
        `SELECT runner_id FROM cp_runner
         WHERE organization_id = $1 AND runner_id = $2
         FOR UPDATE`,
        [authenticated.principal.organizationId, authenticated.principal.runnerId],
      );
      const pendingReadiness = directory.recordReadiness({
        principal: authenticated.principal,
        receipt,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await rotation.query(
        `INSERT INTO cp_runner_credential(
           organization_id, runner_id, credential_id, credential_generation,
           token_hash, created_at
         ) VALUES($1, $2, 'credential_authority_2', 2,
           'rotated_authority_token_hash', clock_timestamp())`,
        [authenticated.principal.organizationId, authenticated.principal.runnerId],
      );
      await rotation.query(
        `UPDATE cp_runner_credential
         SET revoked_at = clock_timestamp()
         WHERE organization_id = $1 AND runner_id = $2
           AND credential_id = $3`,
        [authenticated.principal.organizationId, authenticated.principal.runnerId,
          authenticated.principal.credentialId],
      );
      await rotation.query(
        `UPDATE cp_runner
         SET current_credential_id = 'credential_authority_2',
             registration_generation = 2, credential_generation = 2,
             updated_at = clock_timestamp()
         WHERE organization_id = $1 AND runner_id = $2`,
        [authenticated.principal.organizationId, authenticated.principal.runnerId],
      );
      await rotation.query("COMMIT");

      await expect(pendingReadiness).resolves.toEqual({
        kind: "conflict",
        reason: "authority_mismatch",
      });
      await expect(fixture.pool.query(
        `SELECT count(*)::int AS count FROM cp_runner_readiness
         WHERE organization_id = 'org_readiness_authority'`,
      ).then(({ rows }) => rows[0])).resolves.toEqual({ count: 0 });
    } finally {
      await rotation.query("ROLLBACK").catch(() => undefined);
      rotation.release();
    }
  });

});
