import { z } from "zod";

export const Envelope = z
  .object({
    id: z.string().min(1),
    direction: z.enum(["inbound", "outbound"]),
    surface: z.string().min(1),
    endpointId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    externalMessageId: z.string().min(1).optional(),
    replyToMessageId: z.string().min(1).optional(),
    correlationToken: z.string().min(1).optional(),
    actorId: z.string().min(1).optional(),
    payload: z.unknown(),
    receivedAt: z.number().optional(),
    sentAt: z.number().optional(),
  })
  .strict();
export type Envelope = z.infer<typeof Envelope>;
