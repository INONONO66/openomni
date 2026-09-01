import { NamedError } from "@openomni/protocol";

const MessageData = NamedError.Unknown.Schema.shape.data;

export const DiscordGatewayFetchError = NamedError.create("DiscordGatewayFetchError", MessageData);
export const DiscordApiError = NamedError.create("DiscordApiError", MessageData);
export const DiscordHandlerMissingError = NamedError.create("DiscordHandlerMissingError", MessageData);
