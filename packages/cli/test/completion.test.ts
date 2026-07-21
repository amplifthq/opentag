import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCompletionWaiveCommand } from "../src/completion.js";
import { createSetupConfig } from "../src/setup.js";

function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "opentag-completion-cli-test-"));
  const path = join(directory, "config.json");
  const config = createSetupConfig({
    language: "en",
    platform: "github",
    projectPath: directory,
    executor: "echo",
    stateDirectory: join(directory, "state"),
    github: {
      token: "ghp_test",
      webhookSecret: "webhook_test",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks",
      autoCreatePullRequest: false,
      port: 3050
    }
  });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function waivedResponse() {
  const assessedAt = "2026-07-21T10:05:00.000Z";
  const waiver = {
    id: "waiver-cli-command-1",
    contractId: "contract-cli-command-1",
    contractVersion: 1,
    cycle: 1,
    actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
    reason: "Bounded exception for this governed cycle.",
    scope: "selected_gates",
    policyScope: "work_context_owner_container",
    gateIds: ["merge", "required_checks"],
    waivedAt: assessedAt
  };
  const contract = {
    id: waiver.contractId,
    version: 1,
    workThreadId: "thread-cli-command-1",
    cycle: 1,
    mode: "governed",
    targetSelectors: [{ key: "primary_change", kind: "change_request", lineage: "current_cycle", cardinality: "exactly_one" }],
    resolvedFrom: [{ scope: "work_context_owner_container", ref: "github:acme/demo", version: "1" }],
    gates: [
      { id: "required_checks", kind: "verification", targetKey: "primary_change", evidenceKind: "source_control.required_checks", requiredOutcome: "passed", minimumAssurance: "verified" },
      { id: "merge", kind: "external_state", targetKey: "primary_change", provider: "github", requiredState: "merged", minimumAssurance: "verified" }
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only",
    createdAt: "2026-07-21T10:00:00.000Z"
  };
  const assessment = {
    id: "assessment-cli-command-1",
    workThreadId: contract.workThreadId,
    contractId: contract.id,
    contractVersion: 1,
    cycle: 1,
    sequence: 2,
    inputDigest: `sha256:${"a".repeat(64)}`,
    targetBindings: [],
    state: "waived",
    evidenceBacked: false,
    gateResults: contract.gates.map((gate) => ({
      gateId: gate.id,
      targetKey: "primary_change",
      state: "waived",
      evidenceIds: [],
      reasonCode: "gate_waived",
      reason: "Gate covered by an attributed bounded waiver.",
      evaluatedAt: assessedAt
    })),
    assessedAt,
    assessedBy: "human",
    acceptedAt: assessedAt,
    waiver
  };
  return {
    outcome: "recorded",
    completion: {
      workThreadId: contract.workThreadId,
      execution: "succeeded",
      completion: "waived",
      evidenceBacked: false,
      contract: { id: contract.id, version: 1, cycle: 1, mode: "governed" },
      currentAssessment: assessment,
      targetBindings: [],
      missingGateIds: [],
      failedGateIds: [],
      blockedGateIds: [],
      nextAction: "No action required.",
      contractSnapshot: contract,
      assessmentHistory: [assessment],
      evidence: [],
      openHumanEscalations: []
    },
    waiver
  };
}

describe("completion waiver command", () => {
  it("submits an attributed, sorted, selected-gate waiver and explains the new assessment", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const output: string[] = [];

    await runCompletionWaiveCommand({
      config: configPath(),
      run: "run_cli_command",
      gate: ["required_checks", "merge", "required_checks"],
      reason: "Bounded exception for this governed cycle.",
      actorProvider: "github",
      actorId: "owner-1",
      actorHandle: "repo-owner",
      scope: "selected_gates",
      policyScope: "work_context_owner_container"
    }, {
      now: () => "2026-07-21T10:05:00.000Z",
      log: (message) => output.push(message),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json(waivedResponse(), { status: 201 });
      }
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:3030/v1/runs/run_cli_command/completion/waivers");
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: "Bounded exception for this governed cycle.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["merge", "required_checks"],
      waivedAt: "2026-07-21T10:05:00.000Z"
    });
    expect(output.join("\n")).toContain("Completion waiver: recorded");
    expect(output.join("\n")).toContain("Completion: waived");
    expect(output.join("\n")).toContain("Assessment lineage: 2:assessment-cli-command-1");
  });

  it("rejects an unbounded scope before reading configuration or calling the dispatcher", async () => {
    await expect(runCompletionWaiveCommand({
      run: "run_cli_command",
      gate: ["merge"],
      reason: "Not bounded.",
      actorProvider: "github",
      actorId: "owner-1",
      scope: "all_gates",
      policyScope: "work_context_owner_container"
    })).rejects.toThrow("--scope must be selected_gates");
  });
});
