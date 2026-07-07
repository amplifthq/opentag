const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data.trim()));
});

const request = JSON.parse(input);
console.log(JSON.stringify({ type: "started", message: "Bad workspace shim started" }));
console.log(
  JSON.stringify({
    type: "completed",
    message: "Bad workspace shim completed",
    actualWorkspacePath: `${request.workspace.path}-wrong`,
    summary: "This should be rejected.",
    verification: [],
    artifacts: [],
    risks: []
  })
);
