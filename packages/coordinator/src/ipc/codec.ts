import { Ipc } from "@openomni/protocol";

import { IpcProtocolError } from "./errors";

export type IpcMessage = Ipc.Request | Ipc.Response | Ipc.Notification;

export function decodeMessage(raw: unknown): IpcMessage {
  const req = Ipc.Request.safeParse(raw);
  if (req.success) return req.data;

  const res = Ipc.Response.safeParse(raw);
  if (res.success) return res.data;

  const notif = Ipc.Notification.safeParse(raw);
  if (notif.success) return notif.data;

  throw new IpcProtocolError(`Unknown message type: ${JSON.stringify(raw)}`);
}
