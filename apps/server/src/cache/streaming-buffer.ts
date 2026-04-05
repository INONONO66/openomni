import { Session } from "@openomni/session";
import type { Message } from "@openomni/protocol";
import { sessionCache } from "./session-cache";

export class StreamingBuffer {
  private buffer = "";
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private flushedLength = 0;
  private readonly intervalMs: number;

  constructor(
    private readonly sessionId: string,
    private readonly messageId: string,
    private readonly partId: string,
    options?: { intervalMs?: number },
  ) {
    this.intervalMs = options?.intervalMs ?? 2000;
  }

  append(token: string): void {
    this.buffer += token;
  }

  startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flushToDb();
    }, this.intervalMs);
  }

  private flushToDb(): void {
    if (this.buffer.length === this.flushedLength) return;

    const part: Message.TextPart = {
      id: this.partId,
      sessionID: this.sessionId,
      messageID: this.messageId,
      type: "text" as const,
      text: this.buffer,
    };

    Session.addPart(this.messageId, part);
    this.flushedLength = this.buffer.length;
  }

  complete(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    try {
      this.flushToDb();
    } finally {
      sessionCache.setStreaming(this.sessionId, false);
    }
  }

  reset(): void {
    this.buffer = "";
    this.flushedLength = 0;
  }

  get currentText(): string {
    return this.buffer;
  }
}
