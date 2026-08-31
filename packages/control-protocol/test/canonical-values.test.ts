import { describe, expect, it } from "vitest";
import {
  compareWellFormedUnicodeStrings,
  ProposalReadinessAssessmentSchema,
  sortWellFormedUnicodeStrings,
  WellFormedUnicodeStringSchema,
} from "../src/completion.js";

describe("Task 8 canonical timestamp contract", () => {
  const assessment = {
    state: "proposal_ready" as const,
    accepted: true,
    candidateId: "candidate_1",
    reasonCodes: ["proposal_ready" as const],
    assessedAt: "2026-08-31T01:02:03.004Z",
  };

  it.each([
    ["year zero", "0000-01-01T00:00:00.000Z", false],
    ["minimum year", "0001-01-01T00:00:00.000Z", true],
    ["maximum year", "9999-12-31T23:59:59.999Z", true],
    ["extended year", "+010000-01-01T00:00:00.000Z", false],
    ["valid leap day", "2024-02-29T00:00:00.000Z", true],
    ["invalid leap day", "2025-02-29T00:00:00.000Z", false],
    ["leap second", "2024-12-31T23:59:60.000Z", false],
    ["24:00", "2024-01-01T24:00:00.000Z", false],
    ["offset", "2026-08-31T09:02:03.004+08:00", false],
    ["no fraction", "2026-08-31T01:02:03Z", false],
    ["one fraction digit", "2026-08-31T01:02:03.0Z", false],
    ["two fraction digits", "2026-08-31T01:02:03.00Z", false],
    ["four fraction digits", "2026-08-31T01:02:03.0000Z", false],
  ])("%s is accepted exactly as specified", (_label, assessedAt, expected) => {
    expect(ProposalReadinessAssessmentSchema.safeParse({ ...assessment, assessedAt }).success)
      .toBe(expected);
  });

  it("rejects malformed Candidate identities without throwing and accepts supplementary scalars", () => {
    for (const malformed of [String.fromCharCode(0xd800), String.fromCharCode(0xdc00)]) {
      expect(() => ProposalReadinessAssessmentSchema.safeParse({
        ...assessment,
        candidateId: malformed,
      })).not.toThrow();
      expect(ProposalReadinessAssessmentSchema.safeParse({
        ...assessment,
        candidateId: malformed,
      }).success).toBe(false);
    }
    expect(ProposalReadinessAssessmentSchema.safeParse({
      ...assessment,
      candidateId: "candidate_😀",
    }).success).toBe(true);
  });
});

describe("Task 8 Unicode scalar contract", () => {
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  const values = ["😀", "é", "e\u0301", "a", "ab"];

  it("rejects lone surrogates and preserves scalar order without mutating input", () => {
    expect(WellFormedUnicodeStringSchema.safeParse(high).success).toBe(false);
    expect(WellFormedUnicodeStringSchema.safeParse(low).success).toBe(false);
    expect(WellFormedUnicodeStringSchema.safeParse("😀").success).toBe(true);
    expect(sortWellFormedUnicodeStrings(values)).toEqual(["a", "ab", "e\u0301", "é", "😀"]);
    expect(values).toEqual(["😀", "é", "e\u0301", "a", "ab"]);
    expect(compareWellFormedUnicodeStrings("é", "e\u0301")).toBeGreaterThan(0);
    expect(() => sortWellFormedUnicodeStrings([high])).toThrow(TypeError);
  });
});
