/**
 * Adapter — common contract for all surface adapters.
 *
 * Adapters are transport layers bridging external platforms (Telegram, Discord,
 * GitHub, TUI, etc.) with the OpenOmni conversation handler. Each adapter
 * declares its capabilities, and the orchestration layer adjusts behavior
 * accordingly.
 */
export namespace Adapter {
  // ── Capabilities ──────────────────────────────────────────────

  /** Declares what a surface adapter supports. */
  export interface Capabilities {
    /** Adapter can deliver streamed response chunks incrementally. */
    streaming: boolean;
    /** Media support per direction. */
    media: {
      send: boolean;
      receive: boolean;
    };
    /** Supports platform-native command registration (e.g. Telegram /commands). */
    commands: boolean;
    /** Supports threaded conversations. */
    threads: boolean;
  }

  // ── Trigger Rules ──────────────────────────────────────────

  /**
   * Composable trigger rules. All rules in a config must pass (AND logic)
   * for the adapter to invoke the message handler.
   * Empty array = always trigger (no filtering).
   */
  export type TriggerRule =
    /** Match specific platform events (e.g. "message", "issue_comment.created"). */
    | { type: "event"; events: string[] }
    /** Require @mention of the bot. DMs implicitly pass. */
    | { type: "mention" }
    /** Require message to start with a prefix (stripped before handler). */
    | { type: "prefix"; value: string }
    /** Match specific labels (e.g. GitHub issue labels). */
    | { type: "label"; values: string[] }
    /** Restrict to specific channels or chats. */
    | { type: "channel"; ids: string[] }
    /** Filter by sender identity. */
    | { type: "sender"; allow?: string[]; deny?: string[] };

  /**
   * Context constructed by the adapter from a platform event.
   * Passed to the trigger evaluation engine.
   */
  export interface TriggerContext {
    /** Platform event identifier (e.g. "message", "issue_comment.created"). */
    event: string;
    /** Was the bot explicitly mentioned? */
    mentioned: boolean;
    /** Channel or chat identifier. */
    channelId?: string;
    /** Sender identifier. */
    senderId: string;
    /** Associated labels (e.g. GitHub issue labels). */
    labels?: string[];
    /** Is this a direct message? DMs bypass mention rules. */
    isDM?: boolean;
    /** Message text content. */
    text: string;
  }

  // ── Delivery Policy ───────────────────────────────────────────

  /**
   * Controls which messages from a multi-step agent run are delivered.
   * - `"all"` — every intermediate message (reasoning steps, tool calls)
   * - `"final"` — only the final assistant response
   *
   * TODO: DeliveryPolicy is not yet enforced — currently a placeholder type only
   */
  export type DeliveryPolicy = "all" | "final";

  // ── Media ─────────────────────────────────────────────────────

  /** A media attachment for inbound or outbound messages. */
  export interface MediaAttachment {
    kind: "image" | "file" | "audio" | "video";
    /** Remote URL. Preferred when the platform accepts URLs directly. */
    url?: string;
    /** Raw binary data. Used when URL is not available. */
    data?: Uint8Array;
    mimeType?: string;
    filename?: string;
  }

  // ── Messages ──────────────────────────────────────────────────

  /** Inbound message: platform → agent. */
  export interface InboundMessage {
    /** Platform-specific message identifier. */
    id: string;
    /** Resolved SurfaceKey for session routing. */
    surfaceKey: string;
    /** Message text content. */
    text: string;
    /** Sender identity. */
    sender: {
      id: string;
      name?: string;
    };
    /** Attached media (images, files, etc.). */
    media?: MediaAttachment[];
    /** ID of the message being replied to. */
    replyToId?: string;
    /** Thread identifier. */
    threadId?: string;
    /** Raw platform payload for escape-hatch access. */
    raw?: unknown;
  }

  /** Outbound message: agent → platform. */
  export interface OutboundMessage {
    text?: string;
    media?: MediaAttachment[];
    replyToId?: string;
    threadId?: string;
  }

  // ── Commands ──────────────────────────────────────────────────

  /** A platform command definition (e.g. /help, /status). */
  export interface Command {
    name: string;
    description: string;
    options?: Array<{
      name: string;
      description: string;
      required?: boolean;
    }>;
  }

  /** Context passed to a command handler. */
  export interface CommandContext {
    command: string;
    args: Record<string, string>;
    message: InboundMessage;
  }

  // ── Handlers ──────────────────────────────────────────────────

  /**
   * Handles an inbound message and returns an optional response.
   * Returning `null` means no response should be sent.
   */
  export type MessageHandler = (
    message: InboundMessage,
  ) => Promise<OutboundMessage | null>;

  /** Handles a platform command invocation. */
  export type CommandHandler = (
    ctx: CommandContext,
  ) => Promise<OutboundMessage | null>;

  /**
   * Streaming sink for adapters that support incremental delivery.
   * The orchestration layer writes chunks; the adapter flushes them
   * to the platform in real time.
   */
  export interface StreamSink {
    /** Append a text chunk. */
    write(text: string): void;
    /** Attach media (forces flush of any buffered text). */
    attach(media: MediaAttachment): void;
    /** Signal that the response is complete. */
    end(): void;
    /** Signal an error. */
    error(err: Error): void;
  }

  /**
   * Streaming handler — used instead of MessageHandler when the adapter
   * supports incremental delivery.
   */
  export type StreamingHandler = (
    message: InboundMessage,
    sink: StreamSink,
  ) => Promise<void>;

  // ── Config ────────────────────────────────────────────────────

  /** Shared adapter configuration. */
  export interface Config {
    /** Composable trigger rules. AND logic — all must pass. Empty = always. */
    triggers: TriggerRule[];
    /** Which messages from a multi-step run to deliver. */
    deliveryPolicy: DeliveryPolicy;
  }

  // ── Surface Interface ─────────────────────────────────────────

  /**
   * A surface adapter — bridges a platform with the OpenOmni agent.
   *
   * Adapters declare capabilities and accept configuration. The orchestration
   * layer wires handlers based on capabilities (e.g. streaming handler for
   * streaming-capable adapters, standard handler for others).
   */
  export interface Surface {
    /** Unique adapter identifier (e.g. "telegram", "discord", "github"). */
    readonly id: string;
    /** What this adapter supports. */
    readonly capabilities: Capabilities;
    /** How this adapter should behave. */
    readonly config: Config;

    // ── Lifecycle ──

    /** Start listening for platform events. */
    start(): Promise<void>;
    /** Stop listening and release resources. */
    stop(): void;

    // ── Inbound ──

    /**
     * Register a handler for incoming messages.
     * The adapter applies trigger and user filtering before invoking.
     */
    onMessage(handler: MessageHandler): void;

    /**
     * Register a streaming handler (optional).
     * When set on a streaming-capable adapter, called instead of the
     * regular message handler.
     */
    onStreamingMessage?(handler: StreamingHandler): void;

    // ── Outbound ──

    /**
     * Send a message to a specific surface.
     * Used for proactive messages or orchestration-managed delivery.
     */
    send(surfaceKey: string, message: OutboundMessage): Promise<void>;

    // ── Commands (optional) ──

    /** Register commands with the platform. */
    registerCommands?(commands: Command[]): Promise<void>;
    /** Register a handler for command invocations. */
    onCommand?(handler: CommandHandler): void;
  }
}
