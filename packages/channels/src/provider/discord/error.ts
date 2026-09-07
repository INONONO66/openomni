import { NamedError } from "@openomni/protocol";
import { z } from "zod";

const MessageData = NamedError.Unknown.Schema.shape.data;

export const DiscordGatewayFetchError = NamedError.create("DiscordGatewayFetchError", MessageData);
export const DiscordApiError = NamedError.create(
  "DiscordApiError",
  MessageData.extend({ rejected: z.boolean().optional() }),
);
export const DiscordHandlerMissingError = NamedError.create(
  "DiscordHandlerMissingError",
  MessageData,
);
