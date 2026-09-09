import type { ServerWebSocket } from "bun";
import { z } from "zod";

const frameSchema = z.object({ text: z.string(), replyToId: z.string().optional() });
export type ClientFrame = z.infer<typeof frameSchema>;

export function serveChat(onMessage: (socket: ServerWebSocket<undefined>, frame: ClientFrame) => void) {
  return Bun.serve<undefined>({
    port: 0,
    fetch(request, instance) {
      if (instance.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, data) { onMessage(socket, frameSchema.parse(JSON.parse(String(data)))); },
    },
  });
}
