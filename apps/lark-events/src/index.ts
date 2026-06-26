import { larkIngressConfigFromEnv, startLarkIngress } from "./ingress.js";

const ingress = startLarkIngress(larkIngressConfigFromEnv(process.env));

ingress.startPromise.catch((error: unknown) => {
  console.error("[lark] failed to start long-connection client:", error);
  process.exit(1);
});

console.log("OpenTag Lark events long-connection ingress started");
