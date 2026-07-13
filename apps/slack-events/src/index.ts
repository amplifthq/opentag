import {
  startSlackIngress,
  startSlackSocketModeIngress
} from "@opentag/slack";
import { eventsApiConfigFromEnv, slackModeFromEnv, socketModeConfigFromEnv } from "./config.js";

const mode = slackModeFromEnv(process.env);

if (mode === "socket_mode") {
  const ingress = startSlackSocketModeIngress(socketModeConfigFromEnv(process.env));
  ingress.startPromise.catch((error: unknown) => {
    console.error("OpenTag Slack Socket Mode ingress failed:", error);
    process.exitCode = 1;
  });
  console.log("OpenTag Slack Socket Mode ingress connecting");
} else {
  const ingress = startSlackIngress(eventsApiConfigFromEnv(process.env));
  console.log(`OpenTag Slack events ingress listening on ${ingress.url}`);
}
