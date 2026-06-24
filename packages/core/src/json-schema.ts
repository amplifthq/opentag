import { zodToJsonSchema } from "zod-to-json-schema";
import { OpenTagEventSchema, OpenTagRunResultSchema, OpenTagRunSchema } from "./schema.js";

export const OpenTagJsonSchemas = {
  OpenTagEvent: zodToJsonSchema(OpenTagEventSchema, "OpenTagEvent"),
  OpenTagRun: zodToJsonSchema(OpenTagRunSchema, "OpenTagRun"),
  OpenTagRunResult: zodToJsonSchema(OpenTagRunResultSchema, "OpenTagRunResult")
} as const;
