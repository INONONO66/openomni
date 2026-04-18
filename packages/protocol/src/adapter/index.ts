export namespace Adapter {
  export interface Capabilities {
    streaming: boolean;
    media: {
      send: boolean;
      receive: boolean;
    };
    commands: boolean;
    threads: boolean;
  }

  // TriggerRule uses AND logic — all rules must pass. Empty array = always trigger.
  export type TriggerRule =
    | { type: "event"; events: string[] }
    | { type: "mention" }
    | { type: "prefix"; value: string }
    | { type: "label"; values: string[] }
    | { type: "channel"; ids: string[] }
    | { type: "sender"; allow?: string[]; deny?: string[] };

  export interface TriggerContext {
    event: string;
    mentioned: boolean;
    channelId?: string;
    senderId: string;
    labels?: string[];
    /** DMs bypass mention rules */
    isDM?: boolean;
    text: string;
  }

  // TODO: DeliveryPolicy is not yet enforced — placeholder type only
  export type DeliveryPolicy = "all" | "final";

  export interface MediaAttachment {
    kind: "image" | "file" | "audio" | "video";
    url?: string;
    data?: Uint8Array;
    mimeType?: string;
    filename?: string;
  }

  export interface InboundMessage {
    id: string;
    surfaceKey: string;
    text: string;
    sender: {
      id: string;
      name?: string;
    };
    media?: MediaAttachment[];
    replyToId?: string;
    threadId?: string;
    /** Raw platform payload for escape-hatch access */
    raw?: unknown;
  }

  export interface OutboundMessage {
    text?: string;
    media?: MediaAttachment[];
    replyToId?: string;
    threadId?: string;
  }

  export interface Command {
    name: string;
    description: string;
    options?: Array<{
      name: string;
      description: string;
      required?: boolean;
    }>;
  }

  export interface CommandContext {
    command: string;
    args: Record<string, string>;
    message: InboundMessage;
  }

  /** Returns null to suppress response */
  export type MessageHandler = (message: InboundMessage) => Promise<OutboundMessage | null>;
  export type CommandHandler = (ctx: CommandContext) => Promise<OutboundMessage | null>;

  export interface StreamSink {
    write(text: string): void;
    /** Forces flush of any buffered text */
    attach(media: MediaAttachment): void;
    end(): void;
    error(err: Error): void;
  }

  export type StreamingHandler = (message: InboundMessage, sink: StreamSink) => Promise<void>;

  export interface Config {
    triggers: TriggerRule[];
    deliveryPolicy: DeliveryPolicy;
  }

  export interface Surface {
    readonly id: string;
    readonly capabilities: Capabilities;
    readonly config: Config;

    start(): Promise<void>;
    stop(): void;

    onMessage(handler: MessageHandler): void;
    /** When set on a streaming-capable adapter, called instead of the regular message handler */
    onStreamingMessage?(handler: StreamingHandler): void;

    send(surfaceKey: string, message: OutboundMessage): Promise<void>;

    registerCommands?(commands: Command[]): Promise<void>;
    onCommand?(handler: CommandHandler): void;
  }
}
