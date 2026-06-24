import { describe, expect, it } from "vitest";
import { parseOpenTagMention } from "../src/mention.js";

describe("parseOpenTagMention", () => {
  it("parses fix intent after @opentag", () => {
    expect(parseOpenTagMention("@opentag fix this flaky test")).toMatchObject({
      matched: true,
      rawText: "fix this flaky test",
      intent: "fix",
      args: { prompt: "this flaky test" },
      parsed: {
        version: "v1",
        prompt: "this flaky test",
        flags: {},
        references: [],
        requestedScopes: [],
        diagnostics: []
      }
    });
  });

  it("ignores comments without an opentag mention", () => {
    expect(parseOpenTagMention("please fix this")).toEqual({ matched: false });
  });

  it("supports multiline comments", () => {
    expect(parseOpenTagMention("context\n@opentag review this PR\nthanks")).toMatchObject({
      matched: true,
      rawText: "review this PR",
      intent: "review",
      args: { prompt: "this PR" }
    });
  });

  it("parses quoted flag values and command references", () => {
    expect(parseOpenTagMention('@opentag review "the auth flow" --file src/auth.ts --range 10-20 --approval required')).toMatchObject({
      matched: true,
      rawText: 'review "the auth flow" --file src/auth.ts --range 10-20 --approval required',
      intent: "review",
      args: {
        prompt: "the auth flow",
        file: "src/auth.ts",
        range: "10-20",
        approval: "required"
      },
      parsed: {
        prompt: "the auth flow",
        flags: {
          file: "src/auth.ts",
          range: "10-20",
          approval: "required"
        },
        references: [
          {
            kind: "file",
            uri: "src/auth.ts",
            startLine: 10,
            endLine: 20
          }
        ],
        approval: "required"
      }
    });
  });

  it("parses equals flags, repeated scopes, network, and executor hints", () => {
    expect(
      parseOpenTagMention("@opentag run pnpm test --scope=repo:read --scope repo:write --network restricted --executor codex")
    ).toMatchObject({
      matched: true,
      intent: "run",
      args: {
        prompt: "pnpm test",
        scope: "repo:read,repo:write",
        network: "restricted",
        executor: "codex"
      },
      parsed: {
        prompt: "pnpm test",
        flags: {
          scope: ["repo:read", "repo:write"],
          network: "restricted",
          executor: "codex"
        },
        requestedScopes: ["repo:read", "repo:write", "network:restricted"],
        network: "restricted",
        executorHint: "codex"
      }
    });
  });

  it("collects multiline DSL blocks after an intent-only first line", () => {
    expect(
      parseOpenTagMention(`please take a look
@opentag fix
flaky login tests
--path packages/auth
--approval required`)
    ).toMatchObject({
      matched: true,
      rawText: "fix\nflaky login tests\n--path packages/auth\n--approval required",
      intent: "fix",
      args: {
        prompt: "flaky login tests",
        path: "packages/auth",
        approval: "required"
      },
      parsed: {
        references: [{ kind: "path", uri: "packages/auth" }],
        approval: "required"
      }
    });
  });

  it("reports warnings for unknown flags and invalid policy hints without dropping the command", () => {
    const command = parseOpenTagMention("@opentag investigate outage --scope admin:all --network open --unknown yep");

    expect(command).toMatchObject({
      matched: true,
      intent: "investigate",
      args: {
        prompt: "outage",
        scope: "admin:all",
        network: "open",
        unknown: "yep"
      },
      parsed: {
        requestedScopes: []
      }
    });
    expect(command.matched && command.parsed?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "unknown_flag",
      "invalid_scope",
      "invalid_network_policy"
    ]);
  });
});
