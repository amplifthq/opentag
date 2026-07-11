const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data.trim()));
});

const request = JSON.parse(input);
console.log(JSON.stringify({ type: "progress", message: "Captured child diagnostic before failure" }));
console.log(
  JSON.stringify({
    type: "failed",
    message: "Structured child failure",
    actualWorkspacePath: request.workspace.path
  })
);
process.exitCode = 17;
