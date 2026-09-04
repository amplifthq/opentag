import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Slack teammate documentation contract", () => {
  it("presents Slack as the Source App and GitHub as target/publication", () => {
    const readme = repoFile("README.md");
    expect(readme).toContain("Your persistent AI teammate in Slack");
    expect(readme).toContain("Slack is the only Source App");
    expect(readme).toMatch(/GitHub is a Project\s+Target plus an optional publication and evidence provider/iu);
    expect(readme).toContain("one paired Runner");
    expect(readme).toContain("one ACP coding agent");
  });

  it("keeps the platform index limited to the two supported roles", () => {
    const index = repoFile("docs/platforms/README.md");
    expect(index).toContain("Persistent teammate presence");
    expect(index).toContain("Slack");
    expect(index).toContain("Project Target");
    expect(index).toContain("GitHub");
    const dataRows = index.split("\n").filter((line) => line.startsWith("|") && !line.includes("---"));
    expect(dataRows).toHaveLength(3);
  });

  it("keeps Slack setup on the Control Plane paired-relay path", () => {
    const guide = repoFile("docs/platforms/slack.en.md");
    expect(guide).toContain("paired_relay");
    expect(guide).toContain("self-hosted Control Plane");
    expect(guide).toContain("Events API");
    expect(guide).toContain("signing secret");
    expect(guide).toContain("credentials are Control Plane");
  });

  it("describes GitHub as a governed Project Target and evidence provider", () => {
    const guide = repoFile("docs/platforms/github.en.md");
    expect(guide).toContain("GitHub");
    expect(guide).toMatch(/pull request|draft PR/iu);
    expect(guide).toMatch(/evidence|readback|check/iu);
  });

  it("keeps the agent install guide and repo skill on the published CLI path", () => {
    const install = repoFile("docs/agent-install.md");
    const skill = repoFile("skills/opentag/SKILL.md");
    expect(install).toContain("npm install -g @opentag/cli@0.11.0");
    expect(install).toContain("Slack is the source surface");
    expect(install).toContain("GitHub is the Project Target");
    expect(skill).toContain("npm install -g @opentag/cli@0.11.0");
    expect(skill).toContain("Slack is the only Source App");
    expect(skill).toMatch(
      /GitHub is the Project Target and\s+publication\/evidence provider/u,
    );
  });
});
