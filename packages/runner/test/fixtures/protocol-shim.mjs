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
if (request.protocol !== "opentag.executor.v1") {
  throw new Error(`Unexpected protocol ${request.protocol}`);
}
if (!request.session.key.includes(request.runId)) {
  throw new Error("Session key must include run id.");
}

mkdirSync(request.workspace.path, { recursive: true });
writeFileSync(join(request.workspace.path, "protocol-output.txt"), `run=${request.runId}\nsession=${request.session.key}\n`);
writeFileSync(join(request.workspace.path, "protocol-request.json"), JSON.stringify(request, null, 2));

console.log(JSON.stringify({ type: "started", message: "Protocol shim started" }));
console.log(JSON.stringify({ type: "progress", message: "Protocol shim wrote files" }));
console.log(
  JSON.stringify({
    type: "completed",
    message: "Protocol shim completed",
    actualWorkspacePath: request.workspace.path,
    summary: "Protocol shim completed the run.",
    verification: [{ command: "protocol-shim self-check", outcome: "passed", summary: "Workspace and session were validated." }],
    artifacts: [],
    risks: []
  })
);
