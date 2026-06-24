import { describe, expect, it } from "vitest";
import { OpenTagJsonSchemas } from "../src/json-schema.js";

describe("OpenTagJsonSchemas", () => {
  it("exports public JSON Schemas for protocol objects", () => {
    expect(OpenTagJsonSchemas.OpenTagEvent).toMatchObject({
      $ref: "#/definitions/OpenTagEvent",
      definitions: {
        OpenTagEvent: {
          type: "object"
        }
      }
    });
    expect(OpenTagJsonSchemas.OpenTagRun).toHaveProperty("definitions.OpenTagRun");
    expect(OpenTagJsonSchemas.OpenTagRunResult).toHaveProperty("definitions.OpenTagRunResult");
  });
});
