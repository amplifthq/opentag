import { expect, it } from "vitest";
import { runBuiltinAcpConformance } from "../../../scripts/test/builtin-acp-conformance.js";

it.skipIf(process.env.OPENTAG_RUN_BUILTIN_ACP_CONFORMANCE !== "1")(
  "runs built-in ACP conformance",
  async () => {
    await expect(runBuiltinAcpConformance()).resolves.toBeUndefined();
  },
  900_000
);
