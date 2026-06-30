import { describe, expect, it } from "vitest";
import { gitlabProjectWebhooksSettingsUrl } from "../../../src/platforms/gitlab/display.js";

describe("gitlabProjectWebhooksSettingsUrl", () => {
  it("renders a well-formed URL for a clean path", () => {
    expect(gitlabProjectWebhooksSettingsUrl({ projectPathWithNamespace: "acme/demo" })).toBe(
      "https://gitlab.com/acme/demo/-/hooks"
    );
  });

  it("trims a trailing slash from the project path", () => {
    expect(gitlabProjectWebhooksSettingsUrl({ projectPathWithNamespace: "acme/demo/" })).toBe(
      "https://gitlab.com/acme/demo/-/hooks"
    );
  });

  it("trims a leading slash from the project path", () => {
    expect(gitlabProjectWebhooksSettingsUrl({ projectPathWithNamespace: "/acme/demo" })).toBe(
      "https://gitlab.com/acme/demo/-/hooks"
    );
  });
});
