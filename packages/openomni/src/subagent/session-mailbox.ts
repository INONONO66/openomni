// Session mailbox actor: each session has a bounded MPSC queue so concurrent
// operations on the same session are serialized (FIFO) while different sessions
// run in parallel.

import { Log } from "@openomni/session";

type MailboxEntry<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

const MAX_QUEUE_DEPTH = 1000;
const WARN_THRESHOLD = Math.floor(MAX_QUEUE_DEPTH * 0.8);

const mailboxes = new Map<string, MailboxEntry<unknown>[]>();
const processing = new Set<string>();

async function drainMailbox(sessionId: string): Promise<void> {
  if (processing.has(sessionId)) return;
  processing.add(sessionId);
  Log.debug("mailbox.lock.acquired", {
    sessionId,
    queueDepth: mailboxes.get(sessionId)?.length ?? 0,
  });

  try {
    while (true) {
      const queue = mailboxes.get(sessionId);
      if (!queue || queue.length === 0) break;

      const entry = queue.shift();
      if (!entry) continue;
      if (queue.length === 0) mailboxes.delete(sessionId);

      try {
        const result = await entry.fn();
        entry.resolve(result);
      } catch (err) {
        entry.reject(err);
      }
    }
  } finally {
    processing.delete(sessionId);
    Log.debug("mailbox.lock.released", { sessionId });
    // Items may have been enqueued while we awaited the last entry
    if (mailboxes.has(sessionId)) {
      Promise.resolve().then(() => drainMailbox(sessionId));
    }
  }
}

export function sendToMailbox<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queue = mailboxes.get(sessionId) ?? [];

    // Check if queue is at max depth before enqueuing
    if (queue.length >= MAX_QUEUE_DEPTH) {
      const err = new Error(
        `Mailbox queue depth exceeded for session ${sessionId}: ${queue.length} >= ${MAX_QUEUE_DEPTH}`,
      );
      reject(err);
      return;
    }

    queue.push({ fn, resolve, reject } as MailboxEntry<unknown>);
    mailboxes.set(sessionId, queue);

    // Warn when queue reaches 80% of max depth
    if (queue.length >= WARN_THRESHOLD) {
      Log.warn("mailbox.queue.high", {
        sessionId,
        queueDepth: queue.length,
        maxDepth: MAX_QUEUE_DEPTH,
      });
    }

    Log.debug("mailbox.enqueued", { sessionId, queueDepth: queue.length });
    drainMailbox(sessionId);
  });
}

export function getMailboxDepth(sessionId: string): number {
  return mailboxes.get(sessionId)?.length ?? 0;
}

export function clearMailbox(sessionId: string): void {
  mailboxes.delete(sessionId);
  processing.delete(sessionId);
}
