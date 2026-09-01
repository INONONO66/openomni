import { NamedError } from "@openomni/protocol";

const MessageData = NamedError.Unknown.Schema.shape.data;

export const SlackApiError = NamedError.create("SlackApiError", MessageData);
export const SlackHandlerMissingError = NamedError.create("SlackHandlerMissingError", MessageData);
export const SlackEndpointKeyError = NamedError.create("SlackEndpointKeyError", MessageData);
