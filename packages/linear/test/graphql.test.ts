import { describe, expect, it } from "vitest";
import { linearGraphql } from "../src/graphql.js";

describe("linearGraphql", () => {
  it("includes the operation name when Linear returns GraphQL errors", async () => {
    const fetchImpl = (async () =>
      Response.json({
        errors: [{ message: "missing write scope" }, { message: "issue not found" }]
      })) as typeof fetch;

    await expect(
      linearGraphql({
        token: "lin_api_test",
        fetchImpl,
        query: `mutation OpenTagUpdateLinearIssue($id: String!) {
  issueUpdate(id: $id, input: { priority: 2 }) { success }
}`,
        variables: { id: "issue_123" }
      })
    ).rejects.toThrow("Linear GraphQL OpenTagUpdateLinearIssue failed: 200 missing write scope; issue not found");
  });

  it("includes the operation name when Linear returns no data", async () => {
    const fetchImpl = (async () => Response.json({})) as typeof fetch;

    await expect(
      linearGraphql({
        token: "lin_api_test",
        fetchImpl,
        query: `query OpenTagLinearLiveSmokeIssue($id: String!) {
  issue(id: $id) { id }
}`,
        variables: { id: "ENG-123" }
      })
    ).rejects.toThrow("Linear GraphQL OpenTagLinearLiveSmokeIssue returned no data.");
  });
});
