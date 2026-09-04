import { describe, expect, it } from "vitest";
import config from "../../../vitest.config.js";

type InlineTestProject = {
  test?: {
    name?: string;
    include?: string[];
    exclude?: string[];
    fileParallelism?: boolean;
    sequence?: { groupOrder?: number };
  };
};

describe("PostgreSQL migration test isolation", () => {
  it("runs catalog-mutating migration tests after the parallel repository suite", () => {
    const projects = config.test?.projects as InlineTestProject[] | undefined;
    const repository = projects?.find((project) => project.test?.name === "repository")?.test;
    const migrations = projects?.find((project) => project.test?.name === "migration-corpus")?.test;

    expect(repository).toMatchObject({
      exclude: expect.arrayContaining(["apps/control-plane/test/migrations.postgres.test.ts"]),
      sequence: { groupOrder: 0 },
    });
    expect(migrations).toMatchObject({
      include: ["apps/control-plane/test/migrations.postgres.test.ts"],
      fileParallelism: false,
      sequence: { groupOrder: 1 },
    });
  });
});
