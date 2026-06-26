import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/config.ts",
    "src/daemon.ts",
    "src/dispatcher.ts",
    "src/doctor.ts",
    "src/pr.ts",
    "src/runtime.ts"
  ],
  format: ["esm"],
  sourcemap: true,
  clean: true
});
