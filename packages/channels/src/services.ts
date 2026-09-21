import { Context, type Effect } from "effect";
import type { ChannelError } from "./errors";
import type { WebSocketFrameOutcome, WsConnectionData } from "./websocket";

/** Native frame admission; the app owns callback execution and receipt delivery. */
export class WebSocketFrames extends Context.Tag("@openomni/channels/WebSocketFrames")<
  WebSocketFrames,
  {
    readonly handleFrame: (
      connection: WsConnectionData,
      data: string | Buffer,
    ) => Effect.Effect<WebSocketFrameOutcome, ChannelError>;
  }
>() {}
