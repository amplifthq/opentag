import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenTagEventSchema, OpenTagRunResultSchema, type OpenTagEvent, type OpenTagRunResult } from "@opentag/core";
import { createDispatcherApp } from "../src/server.js";

type ReplayFixture = {
  name: string;
  runId: string;
  event: OpenTagEvent;
  executorCapability: Record<string, unknown>;
  result: OpenTagRunResult;
  expected: {
    artifactTypes: string[];
    ledgerCategories: string[];
    finalBodyContains: string[];
  };
};

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function loadFixture(name: string): ReplayFixture {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/replay/${name}.json`, import.meta.url), "utf8")) as ReplayFixture;
  return {
    ...raw,
    event: OpenTagEventSchema.parse(raw.event),
    result: OpenTagRunResultSchema.parse(raw.result)
  };
}

const fixtures = [loadFixture("github-governed-loop"), loadFixture("slack-governed-loop")];

describe("source-thread replay harness", () => {
  for (const fixture of fixtures) {
    it(`replays ${fixture.name}`, async () => {
      const delivered: Array<{ kind: string; body: string }> = [];
      const app = createDispatcherApp({
        databasePath: ":memory:",
        callbackSink: {
          async deliver(message) {
            delivered.push({ kind: message.kind, body: message.body });
          }
        }
      });

      await expect(
        app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Replay Runner" }))
      ).resolves.toMatchObject({ status: 201 });
      await expect(
        app.request(
          "/v1/repo-bindings",
          jsonRequest({
            provider: "github",
            owner: "acme",
            repo: "demo",
            runnerId: "runner_1",
            workspacePath: "/Users/test/demo",
            defaultExecutor: "echo",
            allowedActors: ["octocat", "alice"]
          })
        )
      ).resolves.toMatchObject({ status: 201 });

      const createResponse = await app.request("/v1/runs", jsonRequest({ runId: fixture.runId, event: fixture.event }));
      expect(createResponse.status).toBe(201);

      const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
      expect(claimResponse.status).toBe(200);

      const runningResponse = await app.request(
        `/v1/runners/runner_1/runs/${fixture.runId}/running`,
        jsonRequest({
          executor: "echo",
          executorCapability: fixture.executorCapability,
          idempotencyKey: `runner_1:${fixture.runId}:running`
        })
      );
      expect(runningResponse.status).toBe(200);

      const completeResponse = await app.request(
        `/v1/runners/runner_1/runs/${fixture.runId}/complete`,
        jsonRequest({
          result: fixture.result,
          idempotencyKey: `runner_1:${fixture.runId}:complete`
        })
      );
      expect(completeResponse.status).toBe(200);

      const runResponse = await app.request(`/v1/runs/${fixture.runId}`);
      expect(runResponse.status).toBe(200);
      const { run } = (await runResponse.json()) as { run: { result?: OpenTagRunResult } };
      const artifactTypes = run.result?.artifacts?.map((artifact) => artifact.type) ?? [];
      expect(artifactTypes).toEqual(expect.arrayContaining(fixture.expected.artifactTypes));
      expect(run.result?.artifacts?.every((artifact) => artifact.sourceRunId === fixture.runId)).toBe(true);

      const ledgerResponse = await app.request(`/v1/runs/${fixture.runId}/ledger`);
      expect(ledgerResponse.status).toBe(200);
      const { ledger } = (await ledgerResponse.json()) as { ledger: { entries: Array<{ category: string; type: string }> } };
      expect(ledger.entries.map((entry) => entry.category)).toEqual(expect.arrayContaining(fixture.expected.ledgerCategories));
      expect(ledger.entries.map((entry) => entry.type)).toEqual(
        expect.arrayContaining(["source_event.received", "context_packet.generated", "executor.capability.snapshot", "artifact.created", "run.completed"])
      );

      const final = delivered.find((message) => message.kind === "final");
      expect(final).toBeDefined();
      for (const expectedText of fixture.expected.finalBodyContains) {
        expect(final?.body).toContain(expectedText);
      }
    });
  }
});
