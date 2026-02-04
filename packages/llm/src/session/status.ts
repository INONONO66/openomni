import { z } from "zod";
import { BusEvent, Bus } from "./bus";

export namespace SessionStatus {
  export const Info = z.discriminatedUnion("type", [
    z.object({ type: z.literal("idle") }),
    z.object({ type: z.literal("busy") }),
    z.object({
      type: z.literal("retry"),
      attempt: z.number(),
      message: z.string(),
      next: z.number(),
    }),
    z.object({
      type: z.literal("error"),
      message: z.string(),
    }),
  ]);
  export type Info = z.infer<typeof Info>;

  const statuses = new Map<string, Info>();

  export const Event = {
    Changed: BusEvent.define(
      "session.status.changed",
      z.object({
        sessionID: z.string(),
        status: Info,
      }),
    ),
  };

  export function get(sessionID: string): Info {
    return statuses.get(sessionID) ?? { type: "idle" };
  }

  export function set(sessionID: string, status: Info): void {
    statuses.set(sessionID, status);
    Bus.publish(Event.Changed, { sessionID, status });
  }

  export function assertNotBusy(sessionID: string): void {
    const current = get(sessionID);
    if (current.type === "busy") {
      throw new Error(`Session ${sessionID} is busy`);
    }
  }

  export function reset(): void {
    statuses.clear();
  }
}
