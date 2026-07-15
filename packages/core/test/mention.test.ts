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

  it("keeps the last value for duplicate single-value flags", () => {
    const parsed = parseOpenTagMention("@opentag fix auth --executor echo --executor codex");
    expect(parsed).toMatchObject({
      parsed: {
        executorHint: "codex"
      },
      args: {
        executor: "codex"
      }
    });
  });

  it.each(["cursor", "opencode"])("accepts the %s built-in executor hint", (executor) => {
    expect(parseOpenTagMention(`@opentag run this --executor ${executor}`)).toMatchObject({
      matched: true,
      parsed: { executorHint: executor },
      args: { executor }
    });
  });

  it("preserves blank lines in explicit continuations", () => {
    const parsed = parseOpenTagMention("@opentag fix auth \\\n\n--file src/auth.ts");
    expect(parsed).toMatchObject({
      matched: true,
      rawText: "fix auth\n\n--file src/auth.ts",
      args: {
        prompt: "auth",
        file: "src/auth.ts"
      }
    });
  });
});
