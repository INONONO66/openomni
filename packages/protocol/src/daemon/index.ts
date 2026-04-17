import { z } from "zod";

const sendCommand = z.object({
  type: z.literal("chat.send"),
  prompt: z.string(),
  sessionId: z.string().optional(),
});

const command = sendCommand;

const tokenEvent = z.object({
  type: z.literal("chat.token"),
  token: z.string(),
});

const doneEvent = z.object({
  type: z.literal("chat.done"),
});

const errorEvent = z.object({
  type: z.literal("error"),
  message: z.string(),
});

const event = z.discriminatedUnion("type", [tokenEvent, doneEvent, errorEvent]);

export namespace Daemon {
  export const Command = command;
  export const Event = event;

  export type Command = z.infer<typeof command>;
  export type Event = z.infer<typeof event>;
}
