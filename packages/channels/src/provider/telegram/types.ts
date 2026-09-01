import { z } from "zod";

export const TelegramUserSchema = z.object({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  first_name: z.string().optional(),
  username: z.string().optional(),
});

export interface TelegramMessage {
  message_id: number;
  from?: z.infer<typeof TelegramUserSchema>;
  chat: z.infer<typeof TelegramChatSchema>;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
}

/** Recursive (`reply_to_message`) — the interface above carries the type, z.lazy the runtime shape. */
const TelegramMessageSchema: z.ZodType<TelegramMessage> = z.lazy(() =>
  z.object({
    message_id: z.number(),
    from: TelegramUserSchema.optional(),
    chat: TelegramChatSchema,
    date: z.number(),
    text: z.string().optional(),
    reply_to_message: TelegramMessageSchema.optional(),
  }),
);

export const TelegramUpdateSchema = z.object({
  update_id: z.number(),
  message: TelegramMessageSchema.optional(),
});

export type TelegramUser = z.infer<typeof TelegramUserSchema>;
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
