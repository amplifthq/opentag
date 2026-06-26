import { dispatcherRuntimeInputFromEnv, startDispatcher } from "@opentag/local-runtime";

const dispatcher = startDispatcher(dispatcherRuntimeInputFromEnv(process.env));

console.log(`OpenTag dispatcher listening on ${dispatcher.url}`);
