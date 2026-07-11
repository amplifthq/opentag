import { describe, expect, it } from "vitest";
import { createLinearAdapterMappingDrafts, discoverLinearMetadata } from "../src/discovery.js";

describe("Linear metadata discovery", () => {
  it("normalizes teams, users, states, and labels into mapping drafts", async () => {
    const fetchImpl = linearMetadataFetch({
      teams: [[{ id: "team_eng", key: "ENG", name: "Engineering", displayName: "Engineering", color: "#00ff00" }]],
      users: [
        [
          { id: "user_alice", name: "alice", displayName: "Alice", email: "alice@example.com", active: true, app: false },
          { id: "app_opentag", name: "OpenTag", displayName: "OpenTag", active: true, app: true }
        ]
      ],
      workflowStates: [[{ id: "state_progress", name: "In Progress", type: "started", color: "#123456", team: { id: "team_eng", key: "ENG", name: "Engineering" } }]],
      issueLabels: [
        [
          { id: "label_bug", name: "Bug", color: "#ff0000", isGroup: false, team: { id: "team_eng", key: "ENG", name: "Engineering" } },
          { id: "label_group", name: "Area", color: "#eeeeee", isGroup: true, team: null }
        ]
      ]
    });

    const snapshot = await discoverLinearMetadata({ token: "lin_api_test", fetchImpl });
    expect(snapshot.teams).toEqual(expect.arrayContaining([expect.objectContaining({ id: "team_eng", key: "ENG", name: "Engineering" })]));
    expect(snapshot.users).toEqual(expect.arrayContaining([expect.objectContaining({ id: "user_alice", email: "alice@example.com" })]));
    expect(snapshot.workflowStates).toEqual(expect.arrayContaining([expect.objectContaining({ id: "state_progress", type: "started" })]));
    expect(snapshot.issueLabels).toEqual(expect.arrayContaining([expect.objectContaining({ id: "label_bug", name: "Bug", isGroup: false })]));

    const drafts = createLinearAdapterMappingDrafts(snapshot);
    expect(drafts.find((draft) => draft.domain === "team")?.values).toMatchObject({
      eng: "team_eng",
      engineering: "team_eng",
      team_eng: "team_eng"
    });
    expect(drafts.find((draft) => draft.domain === "status")?.values).toMatchObject({
      in_progress: "state_progress",
      eng_in_progress: "state_progress",
      started: "state_progress"
    });
    expect(drafts.find((draft) => draft.domain === "assignee")?.values).toMatchObject({
      alice: "user_alice",
      "alice@example.com": "user_alice"
    });
    expect(drafts.find((draft) => draft.domain === "label")?.values).toMatchObject({
      bug: "label_bug",
      eng_bug: "label_bug"
    });
  });

  it("follows Linear metadata pagination for every discovered connection", async () => {
    const fetchImpl = linearMetadataFetch({
      teams: [
        [{ id: "team_eng", key: "ENG", name: "Engineering" }],
        [{ id: "team_ops", key: "OPS", name: "Operations" }]
      ],
      users: [
        [{ id: "user_alice", name: "alice", active: true, app: false }],
        [{ id: "user_bob", name: "bob", active: true, app: false }]
      ],
      workflowStates: [
        [{ id: "state_backlog", name: "Backlog", type: "backlog", team: { id: "team_eng", key: "ENG", name: "Engineering" } }],
        [{ id: "state_triage", name: "Triage", type: "unstarted", team: { id: "team_ops", key: "OPS", name: "Operations" } }]
      ],
      issueLabels: [
        [{ id: "label_bug", name: "Bug", color: "#ff0000", isGroup: false, team: { id: "team_eng", key: "ENG", name: "Engineering" } }],
        [{ id: "label_incident", name: "Incident", color: "#ffaa00", isGroup: false, team: { id: "team_ops", key: "OPS", name: "Operations" } }]
      ]
    });

    const snapshot = await discoverLinearMetadata({ token: "lin_api_test", first: 1, fetchImpl });

    expect(snapshot.teams.map((team) => team.id)).toEqual(["team_eng", "team_ops"]);
    expect(snapshot.users.map((user) => user.id)).toEqual(["user_alice", "user_bob"]);
    expect(snapshot.workflowStates.map((state) => state.id)).toEqual(["state_backlog", "state_triage"]);
    expect(snapshot.issueLabels.map((label) => label.id)).toEqual(["label_bug", "label_incident"]);
  });

  it("omits ambiguous shared aliases while keeping scoped Linear metadata mappings", () => {
    const drafts = createLinearAdapterMappingDrafts({
      teams: [
        { id: "team_eng", key: "ENG", name: "Engineering" },
        { id: "team_ops", key: "OPS", name: "Operations" }
      ],
      users: [
        { id: "user_alice_eng", name: "alice", displayName: "Alice", email: "alice.eng@example.com", active: true, app: false },
        { id: "user_alice_ops", name: "alice", displayName: "Alice", email: "alice.ops@example.com", active: true, app: false }
      ],
      workflowStates: [
        { id: "state_eng_progress", name: "In Progress", type: "started", team: { id: "team_eng", key: "ENG", name: "Engineering" } },
        { id: "state_ops_progress", name: "In Progress", type: "started", team: { id: "team_ops", key: "OPS", name: "Operations" } }
      ],
      issueLabels: [
        { id: "label_eng_bug", name: "Bug", color: "#ff0000", isGroup: false, team: { id: "team_eng", key: "ENG", name: "Engineering" } },
        { id: "label_ops_bug", name: "Bug", color: "#ff0000", isGroup: false, team: { id: "team_ops", key: "OPS", name: "Operations" } },
        { id: "label_global_customer", name: "Customer", color: "#00ff00", isGroup: false, team: null }
      ]
    });

    const statusValues = drafts.find((draft) => draft.domain === "status")?.values;
    expect(statusValues).toMatchObject({
      eng_in_progress: "state_eng_progress",
      ops_in_progress: "state_ops_progress"
    });
    expect(statusValues).not.toHaveProperty("in_progress");
    expect(statusValues).not.toHaveProperty("started");

    const teamValues = drafts.find((draft) => draft.domain === "team")?.values;
    expect(teamValues).toMatchObject({
      eng: "team_eng",
      ops: "team_ops"
    });

    const assigneeValues = drafts.find((draft) => draft.domain === "assignee")?.values;
    expect(assigneeValues).toMatchObject({
      "alice.eng@example.com": "user_alice_eng",
      "alice.ops@example.com": "user_alice_ops"
    });
    expect(assigneeValues).not.toHaveProperty("alice");

    const labelValues = drafts.find((draft) => draft.domain === "label")?.values;
    expect(labelValues).toMatchObject({
      eng_bug: "label_eng_bug",
      ops_bug: "label_ops_bug",
      customer: "label_global_customer",
      global_customer: "label_global_customer"
    });
    expect(labelValues).not.toHaveProperty("bug");
  });
});

function linearMetadataFetch(pages: Record<"teams" | "users" | "workflowStates" | "issueLabels", unknown[][]>): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: { after?: string | null } };
    const connectionName = (["teams", "users", "workflowStates", "issueLabels"] as const).find((name) => body.query?.includes(`${name}(`));
    if (!connectionName) return Response.json({ errors: [{ message: "unknown metadata connection" }] }, { status: 400 });
    const index = body.variables?.after ? Number(String(body.variables.after).replace(`${connectionName}_cursor_`, "")) + 1 : 0;
    const nodes = pages[connectionName][index] ?? [];
    const hasNextPage = index < pages[connectionName].length - 1;
    return Response.json({
      data: {
        [connectionName]: {
          nodes,
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? `${connectionName}_cursor_${index}` : null
          }
        }
      }
    });
  }) as typeof fetch;
}
