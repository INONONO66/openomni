/**
 * Slack wire shapes this driver consumes — Socket Mode envelopes and the
 * message event inside `events_api` payloads. Only the fields the driver
 * reads are declared; the full raw payload rides `InboundMessage.raw`.
 */

export interface SlackMessageEvent {
  type: string;
  /** Present on edits, joins, bot posts, etc. — the driver only handles plain user messages. */
  subtype?: string;
  channel: string;
  /** `im` marks a DM; everything else keys as a channel. */
  channel_type?: string;
  user?: string;
  /** Set when a bot (including this one) authored the message. */
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

/** One Socket Mode frame: `hello`, `events_api` (must be acked), or `disconnect`. */
export interface SocketEnvelope {
  type: string;
  envelope_id?: string;
  payload?: {
    team_id?: string;
    event?: SlackMessageEvent;
  };
  reason?: string;
}
