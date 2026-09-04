import { expect, it } from "vitest";
import { runOpenClawAcpConformance } from "../../../scripts/test/openclaw-acp-conformance.js";

it.skipIf(process.env.OPENTAG_RUN_OPENCLAW_ACP_CONFORMANCE !== "1")(
  "runs OpenClaw ACP conformance",
  async () => {
    await expect(runOpenClawAcpConformance()).resolves.toBeUndefined();
  },
  900_000
);
