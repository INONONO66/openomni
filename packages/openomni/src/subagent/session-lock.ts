import { sendToMailbox } from "./session-mailbox.js";

export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return sendToMailbox(sessionId, fn);
}
