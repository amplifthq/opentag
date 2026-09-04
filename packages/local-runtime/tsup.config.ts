import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/config.ts",
    "src/daemon.ts",
    "src/doctor.ts",
    "src/effects/index.ts",
    "src/runtime.ts"
  ],
  format: ["esm"],
  sourcemap: true,
  clean: true
});
