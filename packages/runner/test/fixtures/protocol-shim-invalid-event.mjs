const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data.trim()));
});

const request = JSON.parse(input);
console.log(
  JSON.stringify({
    type: "completed",
    message: "Invalid event shim completed",
    actualWorkspacePath: request.workspace.path,
    summary: "The invalid verification entry must not be ignored.",
    verification: [{ outcome: "unknown" }],
    artifacts: [],
    notes: [],
    risks: []
  })
);
