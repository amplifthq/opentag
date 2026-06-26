import { larkIngressConfigFromEnv, startLarkIngress } from "./ingress.js";

function handleStartupError(error: unknown): never {
  console.error("[lark] failed to start long-connection client:", error);
  process.exit(1);
}

try {
  const ingress = startLarkIngress(larkIngressConfigFromEnv(process.env));
  ingress.startPromise.catch(handleStartupError);
  console.log("OpenTag Lark events long-connection ingress started");
} catch (error) {
  handleStartupError(error);
}
