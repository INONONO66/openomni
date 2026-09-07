import { NamedError } from "@openomni/protocol";
import { z } from "zod";

const MessageData = NamedError.Unknown.Schema.shape.data;

export const SlackApiError = NamedError.create(
  "SlackApiError",
  MessageData.extend({ rejected: z.boolean().optional() }),
);
export const SlackHandlerMissingError = NamedError.create("SlackHandlerMissingError", MessageData);
export const SlackEndpointKeyError = NamedError.create("SlackEndpointKeyError", MessageData);
