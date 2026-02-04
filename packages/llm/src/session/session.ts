import { z } from "zod";
import { Message } from "./message";

export namespace Session {
  export const Info = z.object({
    id: z.string(),
    title: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  });

  export type Info = z.infer<typeof Info>;

  export const storage = new Map<string, Info>();
  export const messages = new Map<string, Message.Info[]>();

  export function create(input: {
    title: string;
    model: { providerID: string; modelID: string };
  }): Info {
    const id = crypto.randomUUID();
    const now = Date.now();

    const session: Info = {
      id,
      title: input.title,
      model: input.model,
      time: {
        created: now,
        updated: now,
      },
    };

    storage.set(id, session);
    messages.set(id, []);

    return session;
  }

  export function get(id: string): Info | undefined {
    return storage.get(id);
  }

  export function list(): Info[] {
    return Array.from(storage.values());
  }

  export function update(
    id: string,
    input: Partial<Omit<Info, "id" | "time">> & {
      time?: Partial<Info["time"]>;
    },
  ): Info | undefined {
    const session = storage.get(id);
    if (!session) return undefined;

    const updated: Info = {
      ...session,
      ...input,
      time: {
        ...session.time,
        updated: Date.now(),
        ...(input.time || {}),
      },
    };

    storage.set(id, updated);
    return updated;
  }

  export function remove(id: string): boolean {
    const exists = storage.has(id);
    if (exists) {
      storage.delete(id);
      messages.delete(id);
    }
    return exists;
  }

  export function addMessage(sessionID: string, message: Message.Info): void {
    const sessionMessages = messages.get(sessionID);
    if (sessionMessages) {
      sessionMessages.push(message);
    }
  }

  export function getMessages(sessionID: string): Message.Info[] {
    return messages.get(sessionID) || [];
  }
}
