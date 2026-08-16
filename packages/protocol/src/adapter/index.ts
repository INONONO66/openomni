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

  export interface MediaAttachment {
    kind: "image" | "file" | "audio" | "video";
    url?: string;
    data?: Uint8Array;
    mimeType?: string;
    filename?: string;
  }

  export interface InboundMessage {
    id: string;
    /** Trace minted by the surface at the first frame of this inbound message (D11 origin) and carried unchanged to the run. */
    traceId: string;
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
  }

  export interface Surface {
    readonly id: string;
    readonly capabilities: Capabilities;
    readonly config: Config;

    start(traceId: string): Promise<void>;
    stop(traceId: string): void;

    onMessage(handler: MessageHandler): void;
    /** When set on a streaming-capable adapter, called instead of the regular message handler */
    onStreamingMessage?(handler: StreamingHandler): void;

    send(surfaceKey: string, message: OutboundMessage): Promise<void>;

    registerCommands?(commands: Command[]): Promise<void>;
    onCommand?(handler: CommandHandler): void;
  }

  /**
   * Pure string codec for surface keys — the wire vocabulary channel
   * adapters and routing share. Moved here from @openomni/session (#499
   * precursor): the codec is adapter vocabulary; storage semantics
   * (register/claim/lookup) stay in the session surface-key store, which
   * imports this codec for format validation.
   *
   * Key format: `<surface-type>:<surface-specific-path>`
   *
   * Channel/peer kind encoding:
   *   - DM:      slack:workspaceA:dm:U123
   *   - Group:   slack:workspaceA:group:C123
   *   - Thread:  slack:workspaceA:group:C123:thread:171000
   *   - Channel: slack:workspaceA:channel:C123
   *   - TUI:     tui:/Users/ino/Develop/OpenOmni
   *   - Chat:    telegram:botId:chat:chatId
   */
  export namespace SurfaceKey {
    export type ChannelKind = "dm" | "group" | "channel" | "thread" | "chat";

    export interface ParsedKey {
      readonly surface: string;
      readonly namespace: string;
      readonly kind: ChannelKind | undefined;
      readonly id: string | undefined;
      readonly threadId: string | undefined;
    }

    export interface ChannelDescriptor {
      /** Surface type (e.g., "slack", "telegram", "tui") */
      surface: string;
      /** Namespace/workspace/bot identifier */
      namespace: string;
      kind: ChannelKind;
      id: string;
      /** Optional thread identifier (creates a sub-key under the channel) */
      threadId?: string;
    }

    /**
     * Assert the surfaceKey wire-format invariant. The single validation
     * authority: `create` and the session store's register/claim call this.
     * @returns the key unchanged when well-formed
     */
    export function assertWellFormed(key: string): string {
      if (!key.includes(":")) {
        throw new Error(
          `Invalid surfaceKey format: "${key}". Must include surface type prefix (e.g., "slack:...")`,
        );
      }
      return key;
    }

    /**
     * Create a surfaceKey from parts.
     * @param parts - Array of strings to join with colons
     * @returns Formatted surfaceKey
     * @throws Error if parts is empty or validation fails
     */
    export function create(parts: string[]): string {
      if (parts.length === 0) {
        throw new Error("SurfaceKey parts cannot be empty");
      }

      return assertWellFormed(parts.join(":"));
    }

    const KNOWN_KINDS: ReadonlySet<string> = new Set<ChannelKind>([
      "dm",
      "group",
      "channel",
      "thread",
      "chat",
    ]);

    export function fromChannel(descriptor: ChannelDescriptor): string {
      const parts = [descriptor.surface, descriptor.namespace, descriptor.kind, descriptor.id];
      if (descriptor.threadId) {
        parts.push("thread", descriptor.threadId);
      }
      return create(parts);
    }

    export function parse(key: string): ParsedKey {
      const segments = key.split(":");
      const surface = segments[0] ?? "";
      const namespace = segments[1] ?? "";

      let kind: ChannelKind | undefined;
      let id: string | undefined;
      let threadId: string | undefined;

      for (let i = 2; i < segments.length; i++) {
        const seg = segments[i];
        if (seg == null) {
          continue;
        }
        if (KNOWN_KINDS.has(seg)) {
          if (seg === "thread") {
            threadId = segments[i + 1];
            i++;
          } else {
            kind = seg as ChannelKind;
            id = segments[i + 1];
            i++;
          }
        }
      }

      return { surface, namespace, kind, id, threadId };
    }
  }
}
