import { z } from "zod";
import type {
  OpenTagChannelIngressVerificationInput,
  OpenTagSourceIngressEvent,
  OpenTagChannelPresentationCommand
} from "./channel-protocol.js";
import type { OpenTagReplyTargetRef } from "./integration-protocol.js";

export const SourceAppCapabilitiesSchema = z
  .object({
    threads: z.boolean(),
    messageUpdate: z.boolean(),
    reactions: z.boolean(),
    interactiveActions: z.boolean(),
    attachments: z.enum(["metadata", "body", "unsupported"]),
    authenticatedDeletion: z.boolean(),
    stableSourceVersions: z.boolean()
  })
  .strict();

export type SourceAppCapabilities = z.infer<typeof SourceAppCapabilitiesSchema>;

export type SourceAppCorePorts<_RawDelivery, NativePresentation> = {
  appId: string;
  protocol: string;
  capabilities: SourceAppCapabilities;
  ingress: {
    verify(input: OpenTagChannelIngressVerificationInput): Promise<unknown>;
    normalize(input: unknown): OpenTagSourceIngressEvent | null;
  };
  context: {
    readThread(input: {
      replyTarget: OpenTagReplyTargetRef;
      sourceMessageId: string;
      maxMessages: 20;
      maxDecodedBytes: 65536;
    }): Promise<{ messages: unknown[]; truncated: boolean; decodedBytes: number }>;
  };
  presentation: {
    render(command: OpenTagChannelPresentationCommand): NativePresentation;
  };
};
