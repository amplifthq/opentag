import { defineConfig } from "vitest/config";

const migrationCorpus = "apps/control-plane/test/migrations.postgres.test.ts";
const repositoryTests = ["packages/**/*.test.ts", "apps/**/*.test.ts"];
const testTimeout = process.env.CI ? 15_000 : 5_000;

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "repository",
          include: repositoryTests,
          exclude: ["**/node_modules/**", migrationCorpus],
          globals: false,
          testTimeout,
          sequence: { groupOrder: 0 }
        }
      },
      {
        extends: true,
        test: {
          name: "migration-corpus",
          include: [migrationCorpus],
          globals: false,
          testTimeout,
          fileParallelism: false,
          sequence: { groupOrder: 1 }
        }
      }
    ]
  },
  resolve: {
    conditions: ["development"]
  }
});
