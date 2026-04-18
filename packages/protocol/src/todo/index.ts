import { z } from "zod";
import { BusEvent } from "../bus/index.js";

export namespace Todo {
  export const Status = z.enum(["pending", "in_progress", "completed", "cancelled"]);
  export type Status = z.infer<typeof Status>;

  export const Priority = z.enum(["high", "medium", "low"]);
  export type Priority = z.infer<typeof Priority>;

  export const Info = z.object({
    id: z.string(),
    sessionId: z.string(),
    content: z.string(),
    status: Status,
    priority: Priority,
    position: z.number().int(),
  });
  export type Info = z.infer<typeof Info>;

  export const Updated = BusEvent.define(
    "todo.updated",
    z.object({
      sessionId: z.string(),
      todos: z.array(Info),
    }),
  );
}
