import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data.trim()));
});

const request = JSON.parse(input);
mkdirSync(request.workspace.path, { recursive: true });
writeFileSync(
  join(request.workspace.path, "protocol-env.json"),
  JSON.stringify({
    inheritedSecret: process.env.OPENTAG_TEST_HOST_SECRET ?? null,
    inheritedMarker: process.env.OPENTAG_TEST_HOST_MARKER ?? null,
    explicitValue: process.env.OPENTAG_TEST_EXPLICIT_VALUE ?? null
  })
);

console.log(
  JSON.stringify({
    type: "completed",
    message: "Protocol environment recorded",
    actualWorkspacePath: request.workspace.path,
    summary: "Recorded the protocol shim environment.",
    verification: [],
    artifacts: [],
    notes: [],
    risks: []
  })
);
