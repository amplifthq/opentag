import { describe, expect, it } from "vitest";
import { parseOpenTagMention } from "../src/mention.js";

describe("parseOpenTagMention", () => {
  it("parses fix intent after @opentag", () => {
    expect(parseOpenTagMention("@opentag fix this flaky test")).toMatchObject({
      matched: true,
      rawText: "fix this flaky test",
      intent: "fix",
      args: {}
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
      args: {}
    });
  });

  it("parses command flags, references, and executor hints into structured metadata", () => {
    const parsed = parseOpenTagMention("@opentag fix auth flow --file src/auth.ts --line 42 --executor codex --scope repo:write");
    expect(parsed).toMatchObject({
      matched: true,
      rawText: "fix auth flow --file src/auth.ts --line 42 --executor codex --scope repo:write",
      intent: "fix",
      args: {
        prompt: "auth flow",
        file: "src/auth.ts",
        line: 42,
        executor: "codex"
      },
      parsed: {
        version: "v1",
        prompt: "auth flow",
        executorHint: "codex",
        requestedScopes: ["repo:write"],
        references: [{ kind: "file", uri: "src/auth.ts", line: 42 }]
      }
    });
  });
});
