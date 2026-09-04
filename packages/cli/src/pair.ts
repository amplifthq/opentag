import { randomUUID } from "node:crypto";
import { createOpenTagClient, OpenTagControlV1HttpError, type OpenTagClient } from "@opentag/client";
import {
  computeGitHubProjectTargetBindingDigestV1,
  GitHubProjectTargetDeclarationV1Schema,
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerProjectTargetUpsertRequestV1Schema,
  RunnerRegistrationRequestV1Schema,
  type GitHubProjectTargetDeclarationV1,
  type RunnerControlContextResponseV1,
  type RunnerCredentialResponseV1
} from "@opentag/control-protocol";
import { compareCanonicalUnicodeStrings } from "@opentag/core";
import {
  HostedControlRegistrationSchema,
  type HostedControlRegistration,
  type HostedControlRegistrationMetadata,
  type TrustedRelayAuthorizationV1
} from "@opentag/local-runtime";
import {
  defaultConfigPath,
  assertRemotePairedRelayEndpoint,
  readCliConfig,
  readCliRawConfig,
  writeHostedControlConfigAtomic,
  type OpenTagCliConfig
} from "./config.js";
import { formatConfiguredProjectTargetSummary } from "./project-target-summary.js";
import {
  TrustedRelayAuthorizationV1Schema,
  assertRelayTransportAllowed,
  canonicalHostedRelayOrigin,
  relayTrustWarning
} from "./relay-security.js";

export type PairCommandOptions = {
  config?: string;
  relay?: string;
  recover?: string;
  trustRelayOrigin?: string;
};

export type PairRelayDependencies = {
  createControlClient?: (options: Parameters<typeof createOpenTagClient>[0]) => Pick<
    OpenTagClient,
    "getRelayCapabilitiesControlV1" | "getRunnerControlContextV1"
      | "registerRunnerControlV1" | "reprovisionRunnerControlV1"
      | "upsertRunnerProjectTargetControlV1"
  >;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "log" | "warn">;
  randomUUID?: () => string;
  now?: () => Date;
  readConfig?: typeof readCliConfig;
  readBootstrapSecret?: () => string | undefined | Promise<string | undefined>;
  readRawConfig?: typeof readCliRawConfig;
  readRecoverySecret?: () => string | undefined | Promise<string | undefined>;
  writeHostedConfig?: typeof writeHostedControlConfigAtomic;
};

type PairRelaySummaryInput = {
  configPath: string;
  config: OpenTagCliConfig;
  registered: boolean;
};

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeRelayUrl(rawRelayUrl: string): string {
  const raw = rawRelayUrl.trim();
  if (!raw) {
    throw new Error("Relay URL must not be empty.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Relay URL must be a valid http or https URL: ${rawRelayUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Relay URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Relay URL must not include credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Relay URL must not include a query string or fragment.");
  }
  return stripTrailingSlash(url.toString());
}

export function controlRequestIdFromOperationId(operationId: string): string {
  return `request:${operationId}`;
}

function registrationMetadata(response: RunnerCredentialResponseV1): HostedControlRegistrationMetadata {
  return {
    schemaVersion: response.schemaVersion,
    protocolVersion: response.protocolVersion,
    organizationId: response.organizationId,
    runnerId: response.runnerId,
    registrationGeneration: response.registrationGeneration,
    credentialGeneration: response.credentialGeneration,
    credentialId: response.credentialId,
    credentialPurpose: response.credentialPurpose,
    createdAt: response.createdAt
  };
}

function rawObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rawDaemon(value: unknown): Record<string, unknown> {
  return rawObject(rawObject(value, "OpenTag config").daemon, "OpenTag daemon config");
}

function assertRawProjectTargetsConfigured(value: unknown): void {
  const repositories = rawDaemon(value).repositories;
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new Error(
      "Project Target setup is incomplete; configure at least one GitHub Project Target before pairing.",
    );
  }
  for (const repository of repositories) {
    const raw = rawObject(repository, "Project Target config");
    if (typeof raw.projectTargetId !== "string" || !raw.projectTargetId.trim()) {
      throw new Error("Every GitHub Project Target requires projectTargetId before pairing.");
    }
  }
}

function assertPersistedRegistration(
  readRawConfig: typeof readCliRawConfig,
  path: string,
  expected: HostedControlRegistration,
  trustedRelay: TrustedRelayAuthorizationV1,
  expectedRunnerToken?: string | null
): void {
  const daemon = rawDaemon(readRawConfig(path));
  if (JSON.stringify(daemon.controlRegistration) !== JSON.stringify(expected)) {
    throw new Error("Hosted Control V1 registration state did not survive atomic config readback.");
  }
  if (JSON.stringify(daemon.trustedRelay) !== JSON.stringify(trustedRelay)) {
    throw new Error("Hosted Control V1 trusted relay authorization did not survive atomic config readback.");
  }
  if (
    (expectedRunnerToken === null && daemon.runnerToken !== undefined)
    || (typeof expectedRunnerToken === "string" && daemon.runnerToken !== expectedRunnerToken)
  ) {
    throw new Error("Hosted Control V1 staged runner credential failed atomic config readback.");
  }
}

function writeHostedState(input: {
  configPath: string;
  controlRegistration: HostedControlRegistration;
  readRawConfig: typeof readCliRawConfig;
  relayUrl: string;
  trustedRelay: TrustedRelayAuthorizationV1;
  runnerToken?: string | null;
  writeHostedConfig: typeof writeHostedControlConfigAtomic;
}): void {
  input.writeHostedConfig(input.configPath, {
    relayUrl: input.relayUrl,
    trustedRelay: input.trustedRelay,
    controlRegistration: input.controlRegistration,
    ...(input.runnerToken !== undefined ? { runnerToken: input.runnerToken } : {})
  });
  assertPersistedRegistration(
    input.readRawConfig,
    input.configPath,
    input.controlRegistration,
    input.trustedRelay,
    input.runnerToken
  );
}

function defaultReadBootstrapSecret(): string | undefined {
  return process.env.OPENTAG_BOOTSTRAP_PAIRING_TOKEN;
}

async function requireBootstrapSecret(
  readBootstrapSecret: () => string | undefined | Promise<string | undefined>
): Promise<string> {
  const secret = (await readBootstrapSecret())?.trim();
  if (!secret) {
    throw new Error(
      "Control Plane bootstrap pairing authority is unavailable; enter it in the local password prompt or set OPENTAG_BOOTSTRAP_PAIRING_TOKEN for this command."
    );
  }
  return secret;
}

function defaultReadRecoverySecret(): string | undefined {
  return process.env.OPENTAG_RECOVERY_CREDENTIAL;
}

async function requireRecoverySecret(
  readRecoverySecret: () => string | undefined | Promise<string | undefined>
): Promise<string> {
  const secret = (await readRecoverySecret())?.trim();
  if (!secret) {
    throw new Error(
      "Runner recovery credential is unavailable; enter it in the local password prompt or set OPENTAG_RECOVERY_CREDENTIAL and retry with --recover <credentialId>."
    );
  }
  return secret;
}

function persistCredentialStage(input: {
  configPath: string;
  operationId: string;
  relayUrl: string;
  response: Extract<RunnerCredentialResponseV1, { replayed: false }>;
  readRawConfig: typeof readCliRawConfig;
  trustedRelay: TrustedRelayAuthorizationV1;
  writeHostedConfig: typeof writeHostedControlConfigAtomic;
}): Extract<HostedControlRegistration, { state: "credential_staged" }> {
  const registration = registrationMetadata(input.response);
  const stagedControl: HostedControlRegistration = {
    kind: "hosted_control_v1",
    state: "credential_staged",
    operationId: input.operationId,
    registration
  };
  writeHostedState({
    configPath: input.configPath,
    controlRegistration: stagedControl,
    readRawConfig: input.readRawConfig,
    relayUrl: input.relayUrl,
    trustedRelay: input.trustedRelay,
    runnerToken: input.response.runnerToken,
    writeHostedConfig: input.writeHostedConfig
  });
  return stagedControl;
}

function projectTargetDeclaration(
  repository: OpenTagCliConfig["daemon"]["repositories"][number],
): GitHubProjectTargetDeclarationV1 {
  return GitHubProjectTargetDeclarationV1Schema.parse({
    projectTargetId: repository.projectTargetId,
    provider: "github",
    owner: repository.owner,
    repo: repository.repo,
    defaultExecutor: repository.defaultExecutor,
    defaultBranch: repository.baseBranch,
  });
}

async function assertProjectTargetReadback(input: {
  context: RunnerControlContextResponseV1;
  registration: HostedControlRegistrationMetadata;
  target: GitHubProjectTargetDeclarationV1;
}): Promise<void> {
  const { context, registration, target } = input;
  if (context.organizationId !== registration.organizationId
    || context.runnerId !== registration.runnerId
    || context.credentialId !== registration.credentialId
    || context.registrationGeneration !== registration.registrationGeneration
    || context.credentialGeneration !== registration.credentialGeneration) {
    throw new Error("Project Target readback did not match the staged Runner authority.");
  }
  const expectedDigest = await computeGitHubProjectTargetBindingDigestV1(target);
  const actual = context.targets.find((candidate) =>
    candidate.projectTargetId === target.projectTargetId);
  if (!actual || actual.bindingDigest !== expectedDigest
    || actual.provider !== target.provider || actual.owner !== target.owner
    || actual.repo !== target.repo || actual.defaultExecutor !== target.defaultExecutor
    || actual.defaultBranch !== target.defaultBranch) {
    throw new Error(`Project Target ${target.projectTargetId} readback did not match its canonical declaration.`);
  }
}

async function synchronizeProjectTargets(input: {
  client: Pick<OpenTagClient, "upsertRunnerProjectTargetControlV1">;
  config: OpenTagCliConfig;
  operationId: string;
  registration: HostedControlRegistrationMetadata;
}): Promise<void> {
  if (input.config.daemon.repositories.length === 0) {
    throw new Error("Project Target setup is incomplete; configure at least one GitHub Project Target before pairing.");
  }
  const targets = input.config.daemon.repositories
    .map(projectTargetDeclaration)
    .sort((left, right) => compareCanonicalUnicodeStrings(
      left.projectTargetId,
      right.projectTargetId,
  ));
  for (const target of targets) {
    const bindingDigest = await computeGitHubProjectTargetBindingDigestV1(target);
    const request = RunnerProjectTargetUpsertRequestV1Schema.parse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.repository-binding.v1"],
      requestId: controlRequestIdFromOperationId(
        `project-target:${input.operationId}:${bindingDigest}`,
      ),
      expectedAuthority: {
        credentialId: input.registration.credentialId,
        registrationGeneration: input.registration.registrationGeneration,
        credentialGeneration: input.registration.credentialGeneration,
      },
      target,
    });
    const context = await input.client.upsertRunnerProjectTargetControlV1({
      runnerId: input.registration.runnerId,
      projectTargetId: target.projectTargetId,
      request,
    });
    await assertProjectTargetReadback({ context, registration: input.registration, target });
  }
}

function replayRecoveryRequired(
  response: Extract<RunnerCredentialResponseV1, { replayed: true }>
): HostedControlRegistration {
  return {
    kind: "hosted_control_v1",
    state: "unpaired",
    reason: "recovery_required",
    registration: registrationMetadata(response)
  };
}

type HostedPairPlan = {
  controlRegistration: HostedControlRegistration;
  reconcileRuntimeCredential?: {
    pairedControl: Extract<HostedControlRegistration, { state: "paired" }>;
    runnerToken: string;
  };
  relayOrigin: string;
  trustedRelay: TrustedRelayAuthorizationV1;
  operationId: string;
  recoveryRegistration?: HostedControlRegistrationMetadata;
};

function hostedPairPlan(input: {
  options: PairCommandOptions;
  rawConfig: unknown;
  relayUrl: string;
  operationId: () => string;
  now: () => Date;
}): HostedPairPlan {
  const daemon = rawDaemon(input.rawConfig);
  const rawControl = daemon.controlRegistration;
  const rawTrust = daemon.trustedRelay;

  const relayOrigin = canonicalHostedRelayOrigin(input.relayUrl);
  const explicitOrigin = input.options.trustRelayOrigin === undefined
    ? undefined
    : canonicalHostedRelayOrigin(input.options.trustRelayOrigin);
  if (explicitOrigin !== undefined && explicitOrigin !== relayOrigin) {
    throw new Error("--trust-relay-origin must exactly match the canonical --relay origin.");
  }
  const persistedTrust = rawTrust === undefined
    ? undefined
    : TrustedRelayAuthorizationV1Schema.parse(rawTrust);
  if (persistedTrust && persistedTrust.origin !== relayOrigin) {
    throw new Error("Hosted Control V1 is already bound to a different trusted relay origin.");
  }
  if (!persistedTrust && explicitOrigin === undefined) {
    throw new Error(
      "Hosted Control V1 requires --trust-relay-origin <origin>; --relay, --yes, TLS, health, and capabilities do not authorize trust."
    );
  }
  const trustedRelay = persistedTrust ?? TrustedRelayAuthorizationV1Schema.parse({
    schemaVersion: 1,
    origin: explicitOrigin,
    authorizedAt: input.now().toISOString(),
    authorizationMethod: "explicit_cli"
  });
  const control = rawControl === undefined
    ? undefined
    : HostedControlRegistrationSchema.parse(rawControl);

  if (control?.state === "credential_staged") {
    const runnerId = daemon.runnerId;
    if (typeof runnerId !== "string" || !runnerId.trim()) {
      throw new Error("Hosted staged credential requires a non-empty raw daemon runnerId.");
    }
    if (control.registration.runnerId !== runnerId) {
      throw new Error("Hosted staged credential runner identity does not match raw daemon runnerId.");
    }
    const runnerToken = daemon.runnerToken;
    if (typeof runnerToken !== "string" || !runnerToken.trim()) {
      throw new Error("Hosted staged credential requires a non-empty inline raw runner token.");
    }
    return {
      controlRegistration: control,
      reconcileRuntimeCredential: {
        pairedControl: { ...control, state: "paired" },
        runnerToken
      },
      relayOrigin,
      trustedRelay,
      operationId: control.operationId
    };
  }

  if (control?.state === "paired") {
    if (input.options.recover !== undefined) {
      throw new Error("A paired Runner cannot enter recovery without recovery-required authority.");
    }
    const runnerId = daemon.runnerId;
    if (typeof runnerId !== "string" || !runnerId.trim()
      || control.registration.runnerId !== runnerId) {
      throw new Error("Paired Runner identity does not match raw daemon runnerId.");
    }
    const runnerToken = daemon.runnerToken;
    if (typeof runnerToken !== "string" || !runnerToken.trim()) {
      throw new Error("Paired Runner target reconciliation requires its runtime credential.");
    }
    return {
      controlRegistration: control,
      reconcileRuntimeCredential: {
        pairedControl: control,
        runnerToken,
      },
      relayOrigin,
      trustedRelay,
      operationId: control.operationId,
    };
  }

  if (input.options.recover !== undefined) {
    const recoveryCredentialId = input.options.recover.trim();
    if (!recoveryCredentialId) {
      throw new Error("--recover requires a non-empty recovery credential id.");
    }
    if (
      control?.state === "unpaired"
      && "flow" in control
      && control.flow === "reprovision"
    ) {
      if (control.recoveryCredentialId !== recoveryCredentialId) {
        throw new Error("Hosted recovery is already pending for a different recovery credential id.");
      }
      return {
        controlRegistration: control,
        relayOrigin,
        trustedRelay,
        operationId: control.operationId,
        recoveryRegistration: control.registration
      };
    }
    if (!control || control.state !== "unpaired" || control.reason !== "recovery_required") {
      throw new Error("Hosted recovery requires a persisted recovery-required registration state.");
    }
    const operationId = input.operationId();
    return {
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "reprovision",
        operationId,
        reason: "pending",
        recoveryCredentialId,
        registration: control.registration
      },
      relayOrigin,
      trustedRelay,
      operationId,
      recoveryRegistration: control.registration
    };
  }

  if (control !== undefined) {
    if (
      control.state === "unpaired"
      && "flow" in control
      && control.flow === "registration"
    ) {
      return {
        controlRegistration: control,
        relayOrigin,
        trustedRelay,
        operationId: control.operationId
      };
    }
    if (control.state === "unpaired" && control.reason === "recovery_required") {
      throw new Error("Hosted Control V1 requires --recover <recoveryCredentialId> for this runner.");
    }
    throw new Error(`Hosted Control V1 pairing cannot start from persisted state ${control.state}.`);
  }

  const operationId = input.operationId();
  return {
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "unpaired",
      flow: "registration",
      operationId,
      reason: "pending"
    },
    relayOrigin,
    trustedRelay,
    operationId
  };
}

export function formatPairRelaySummary(input: PairRelaySummaryInput): string {
  const projectTargets = input.config.daemon.repositories.map((repository) => {
    return `  ${formatConfiguredProjectTargetSummary(repository)}`;
  });
  return [
    "OpenTag relay pairing updated.",
    `Config: ${input.configPath}`,
    `Relay: ${input.config.daemon.relayUrl}`,
    `Runner: ${input.config.daemon.runnerId}`,
    `Registration: ${input.registered ? "completed" : "skipped"}`,
    "Project Target synchronization: verified",
    relayTrustWarning(input.config.daemon.relayUrl),
    "Project Targets:",
    ...(projectTargets.length ? projectTargets : ["  none"]),
    "Next steps:",
    `  opentag start --config ${input.configPath}`,
    `  opentag service install --config ${input.configPath}`,
    `  opentag service start --config ${input.configPath}`
  ].join("\n");
}

async function runHostedPair(input: {
  dependencies: PairRelayDependencies;
  configPath: string;
  plan: HostedPairPlan;
  relayUrl: string;
}): Promise<OpenTagCliConfig> {
  const readRawConfig = input.dependencies.readRawConfig ?? readCliRawConfig;
  const readConfig = input.dependencies.readConfig ?? readCliConfig;
  const writeHostedConfig = input.dependencies.writeHostedConfig
    ?? writeHostedControlConfigAtomic;
  const createControlClient = input.dependencies.createControlClient
    ?? createOpenTagClient;

  writeHostedState({
    configPath: input.configPath,
    controlRegistration: input.plan.controlRegistration,
    readRawConfig,
    relayUrl: input.relayUrl,
    trustedRelay: input.plan.trustedRelay,
    writeHostedConfig
  });

  const capabilityClient = createControlClient({
    controlPlaneUrl: input.plan.relayOrigin,
    ...(input.dependencies.fetchImpl
      ? { fetchImpl: input.dependencies.fetchImpl }
      : {})
  });
  const capabilities = await capabilityClient.getRelayCapabilitiesControlV1();
  const requiredCapabilities = [
    ...(input.plan.reconcileRuntimeCredential ? [] : [input.plan.recoveryRegistration
      ? "relay.credential-reprovision.v1" as const
      : "relay.registration.v1" as const]),
    "relay.repository-binding.v1" as const,
  ];
  for (const requiredCapability of requiredCapabilities) {
    if (!capabilities.capabilities.includes(requiredCapability)) {
      throw new Error(
        `Hosted Control V1 relay does not advertise required capability ${requiredCapability}.`
      );
    }
  }

  // This is intentionally the first full config read. The raw trust and
  // pending-operation readback above must complete before any SecretRef is
  // materialized.
  const config = readConfig(input.configPath);
  if (input.plan.reconcileRuntimeCredential) {
    const runtimeClient = createControlClient({
      controlPlaneUrl: input.plan.relayOrigin,
      controlCredential: {
        kind: "runtime",
        token: input.plan.reconcileRuntimeCredential.runnerToken,
      },
      ...(input.dependencies.fetchImpl
        ? { fetchImpl: input.dependencies.fetchImpl }
        : {}),
    });
    await synchronizeProjectTargets({
      client: runtimeClient,
      config,
      operationId: input.plan.operationId,
      registration: input.plan.reconcileRuntimeCredential.pairedControl.registration,
    });
    writeHostedState({
      configPath: input.configPath,
      controlRegistration: input.plan.reconcileRuntimeCredential.pairedControl,
      readRawConfig,
      relayUrl: input.relayUrl,
      trustedRelay: input.plan.trustedRelay,
      runnerToken: input.plan.reconcileRuntimeCredential.runnerToken,
      writeHostedConfig,
    });
    return readConfig(input.configPath);
  }
  let controlCredential: Parameters<typeof createOpenTagClient>[0]["controlCredential"];
  if (input.plan.recoveryRegistration) {
    controlCredential = {
      kind: "recovery_pairing",
      token: await requireRecoverySecret(
        input.dependencies.readRecoverySecret ?? defaultReadRecoverySecret
      )
    };
  } else {
    controlCredential = {
      kind: "bootstrap_pairing",
      token: await requireBootstrapSecret(
        input.dependencies.readBootstrapSecret ?? defaultReadBootstrapSecret
      )
    };
  }

  const mutationClient = createControlClient({
    controlPlaneUrl: input.plan.relayOrigin,
    controlCredential,
    ...(input.dependencies.fetchImpl
      ? { fetchImpl: input.dependencies.fetchImpl }
      : {})
  });
  let response: RunnerCredentialResponseV1;
  try {
    if (input.plan.recoveryRegistration) {
      response = await mutationClient.reprovisionRunnerControlV1(
        RunnerCredentialReprovisionRequestV1Schema.parse({
          schemaVersion: 1,
          protocolVersion: "1.0",
          requiredCapabilities: ["relay.credential-reprovision.v1"],
          requestId: controlRequestIdFromOperationId(input.plan.operationId),
          operationId: input.plan.operationId,
          runnerId: config.daemon.runnerId,
          recoveryCredentialId: (input.plan.controlRegistration as Extract<
            HostedControlRegistration,
            { flow: "reprovision" }
          >).recoveryCredentialId,
          expectedRegistrationGeneration:
            input.plan.recoveryRegistration.registrationGeneration,
          expectedCredentialGeneration:
            input.plan.recoveryRegistration.credentialGeneration
        })
      );
    } else {
      response = await mutationClient.registerRunnerControlV1(
        RunnerRegistrationRequestV1Schema.parse({
          schemaVersion: 1,
          protocolVersion: "1.0",
          requiredCapabilities: ["relay.registration.v1"],
          requestId: controlRequestIdFromOperationId(input.plan.operationId),
          operationId: input.plan.operationId,
          runnerId: config.daemon.runnerId,
          capabilities: ["relay.repository-binding.v1"]
        })
      );
    }
  } catch (error) {
    if (!(error instanceof OpenTagControlV1HttpError)) {
      const pending = input.plan.controlRegistration;
      if (pending.state !== "unpaired" || !("flow" in pending)) {
        throw new Error("Hosted Control V1 mutation failed before a replayable pending state was available.");
      }
      writeHostedState({
        configPath: input.configPath,
        controlRegistration: {
          ...pending,
          reason: "outcome_unknown"
        },
        readRawConfig,
        relayUrl: input.relayUrl,
        trustedRelay: input.plan.trustedRelay,
        writeHostedConfig
      });
      throw new Error(
        "Hosted Control V1 mutation outcome is unknown. Retry `opentag pair` with the same relay and bootstrap authority; OpenTag will reuse the persisted operation instead of creating another registration."
      );
    }
    throw error;
  }

  if (response.replayed) {
    writeHostedState({
      configPath: input.configPath,
      controlRegistration: replayRecoveryRequired(response),
      readRawConfig,
      relayUrl: input.relayUrl,
      trustedRelay: input.plan.trustedRelay,
      runnerToken: null,
      writeHostedConfig
    });
    throw new Error(
      "Hosted Control V1 registration was replayed without returning the runtime credential; recovery_required. Re-provision this Runner with `opentag pair --recover <recoveryCredentialId>` before starting it."
    );
  } else {
    const stagedControl = persistCredentialStage({
      configPath: input.configPath,
      operationId: input.plan.operationId,
      relayUrl: input.relayUrl,
      response,
      readRawConfig,
      trustedRelay: input.plan.trustedRelay,
      writeHostedConfig
    });
    const runtimeClient = createControlClient({
      controlPlaneUrl: input.plan.relayOrigin,
      controlCredential: { kind: "runtime", token: response.runnerToken },
      ...(input.dependencies.fetchImpl
        ? { fetchImpl: input.dependencies.fetchImpl }
        : {}),
    });
    await synchronizeProjectTargets({
      client: runtimeClient,
      config,
      operationId: input.plan.operationId,
      registration: stagedControl.registration,
    });
    writeHostedState({
      configPath: input.configPath,
      controlRegistration: { ...stagedControl, state: "paired" },
      readRawConfig,
      relayUrl: input.relayUrl,
      trustedRelay: input.plan.trustedRelay,
      runnerToken: response.runnerToken,
      writeHostedConfig,
    });
  }
  return readConfig(input.configPath);
}
export async function runPairCommand(options: PairCommandOptions, dependencies: PairRelayDependencies = {}): Promise<OpenTagCliConfig> {
  if (!options.relay) {
    throw new Error("opentag pair currently requires --relay <url>.");
  }

  const logger = dependencies.logger ?? console;
  const configPath = options.config ?? defaultConfigPath();
  const relayUrl = normalizeRelayUrl(options.relay);
  assertRelayTransportAllowed(relayUrl);
  const readRawConfig = dependencies.readRawConfig ?? readCliRawConfig;
  const rawConfig = readRawConfig(configPath);
  assertRawProjectTargetsConfigured(rawConfig);
  assertRemotePairedRelayEndpoint({ relayUrl });
  const plan = hostedPairPlan({
    options,
    rawConfig,
    relayUrl,
    operationId: dependencies.randomUUID ?? randomUUID,
    now: dependencies.now ?? (() => new Date())
  });
  const updated = await runHostedPair({ dependencies, configPath, plan, relayUrl });

  logger.log(
    formatPairRelaySummary({
      configPath,
      config: updated,
      registered: !plan.reconcileRuntimeCredential
        && updated.daemon.controlRegistration?.state === "paired"
    })
  );
  return updated;
}
